import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";

const SOURCE_CATEGORIES = {
  official: "Resmî",
  academic: "Akademik",
  factCheck: "Doğrulama",
  establishedMedia: "Haber",
  security: "Güvenlik",
  social: "Sosyal",
  lowTrust: "Düşük",
  unknown: "Belirsiz"
};

const WARNING_TERMS = ["sahte", "yalan", "dolandırıcılık", "uyarı", "scam", "false", "phishing"];

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJSON(res, 200, { ok: true, service: "dijikalkan-research-backend" });
    return;
  }

  if (req.method !== "POST" || new URL(req.url, `http://${req.headers.host}`).pathname !== "/research") {
    sendJSON(res, 404, { error: "Not found" });
    return;
  }

  try {
    const body = await readJSON(req);
    const query = String(body.query || "").trim();
    const includeAIConsultation = body.includeAIConsultation !== false;

    if (!query) {
      sendJSON(res, 400, { error: "query is required" });
      return;
    }

    const rawSources = await searchWeb(query);
    const scoredSources = scoreAndRankSources(rawSources, query).slice(0, 8);
    const aiConsultationSummary = includeAIConsultation
      ? await consultAIReviewEndpoints(query, scoredSources)
      : null;

    sendJSON(res, 200, {
      query,
      summaryText: buildSummaryText(scoredSources),
      sources: scoredSources,
      aiConsultationSummary,
      didFail: false
    });
  } catch (error) {
    sendJSON(res, 200, {
      query: "",
      summaryText: `Araştırma servisi isteği tamamlayamadı: ${error.message}`,
      sources: [],
      aiConsultationSummary: null,
      didFail: true
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`DijiKalkan Research Backend listening on http://${HOST}:${PORT}`);
  console.log(`For iPhone on the same Wi-Fi, use http://YOUR_MAC_IP:${PORT}/research`);
});

async function searchWeb(query) {
  if (process.env.TAVILY_API_KEY) {
    const tavilyResults = await searchTavily(query);
    if (tavilyResults.length) return tavilyResults;
  }

  if (process.env.BRAVE_SEARCH_API_KEY) {
    const braveResults = await searchBrave(query);
    if (braveResults.length) return braveResults;
  }

  const bingResults = await searchBingRSS(query);
  if (bingResults.length) return bingResults;

  const duckResults = await searchDuckDuckGo(query);
  if (duckResults.length) return duckResults;

  return sourceHintsFromQuery(query);
}

async function searchTavily(query) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      search_depth: "basic",
      include_answer: true,
      include_raw_content: false,
      max_results: 8
    })
  });

  if (!response.ok) return [];
  const data = await response.json();
  return (data.results || []).map((item) => ({
    title: item.title || item.url || "Kaynak",
    url: item.url || "",
    snippet: item.content || data.answer || ""
  }));
}

async function searchBrave(query) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "8");
  url.searchParams.set("country", "TR");
  url.searchParams.set("search_lang", "tr");

  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY
    }
  });

  if (!response.ok) return [];
  const data = await response.json();
  return (data.web?.results || []).map((item) => ({
    title: item.title || item.url || "Kaynak",
    url: item.url || "",
    snippet: item.description || ""
  }));
}

async function searchDuckDuckGo(query) {
  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("skip_disambig", "1");

  const response = await fetch(url);
  if (!response.ok) return [];

  const data = await response.json();
  const sources = [];

  if (data.AbstractURL) {
    sources.push({
      title: data.AbstractSource || data.Heading || "Özet kaynak",
      url: data.AbstractURL,
      snippet: data.AbstractText || ""
    });
  }

  flattenDuckTopics(data.RelatedTopics || []).forEach((topic) => {
    if (topic.FirstURL) {
      sources.push({
        title: topic.Text || topic.FirstURL,
        url: topic.FirstURL,
        snippet: topic.Text || ""
      });
    }
  });

  return dedupeSources(sources);
}

async function searchBingRSS(query) {
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "rss");
  url.searchParams.set("cc", "tr");
  url.searchParams.set("setlang", "tr-TR");

  const response = await fetch(url, {
    headers: {
      "Accept": "application/rss+xml, application/xml, text/xml",
      "User-Agent": "DijiKalkanResearch/1.0"
    }
  });
  if (!response.ok) return [];

  const xml = await response.text();
  return parseBingRSS(xml);
}

function parseBingRSS(xml) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  return dedupeSources(items.map((match) => {
    const item = match[1];
    return {
      title: decodeXMLTag(item, "title") || "Kaynak",
      url: decodeXMLTag(item, "link"),
      snippet: decodeXMLTag(item, "description")
    };
  }).filter((source) => source.url));
}

function decodeXMLTag(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  if (!match) return "";
  return decodeEntities(stripTags(match[1])).trim();
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function sourceHintsFromQuery(query) {
  const urls = [...query.matchAll(/https?:\/\/[^\s)]+/gi)].map((match) => match[0]);
  return urls.map((url) => ({
    title: safeHost(url) || "Kullanıcının verdiği bağlantı",
    url,
    snippet: "Kullanıcının içerikte paylaştığı bağlantı. Kaynak türü ve alan adı güvenilirlik açısından ayrıca puanlandı."
  }));
}

function flattenDuckTopics(topics) {
  return topics.flatMap((topic) => {
    if (Array.isArray(topic.Topics)) return flattenDuckTopics(topic.Topics);
    return [topic];
  });
}

function scoreAndRankSources(sources, query) {
  return dedupeSources(sources)
    .map((source) => scoreSource(source, query))
    .sort((a, b) => {
      if (a.trustScore === b.trustScore) return b.relevanceScore - a.relevanceScore;
      return b.trustScore - a.trustScore;
    });
}

function scoreSource(source, query) {
  const host = safeHost(source.url);
  const combined = `${source.title} ${source.url} ${source.snippet}`.toLocaleLowerCase("tr-TR");
  const category = categorizeSource(host, combined);
  const { baseTrust, reason } = trustDefaults(category);
  const relevanceScore = relevance(query, combined);
  const warningPenalty = WARNING_TERMS.some((term) => combined.includes(term)) ? -6 : 0;
  const relevanceCap = relevanceScore < 20 ? 35 : relevanceScore < 40 ? 55 : 100;
  const trustScore = clamp(Math.min(baseTrust + (relevanceScore > 55 ? 4 : 0) + warningPenalty, relevanceCap), 0, 100);

  return {
    title: source.title || host || "Kaynak",
    url: source.url || "",
    snippet: source.snippet || "",
    trustScore,
    relevanceScore,
    category,
    reason
  };
}

function categorizeSource(host, combined) {
  if (host.includes("gov.tr") || host.includes("who.int") || host.includes("cdc.gov") || host.includes("europa.eu")) {
    return SOURCE_CATEGORIES.official;
  }
  if (host.includes("edu.tr") || host.includes(".edu") || host.includes("doi.org") || host.includes("pubmed")) {
    return SOURCE_CATEGORIES.academic;
  }
  if (host.includes("usom.gov.tr") || host.includes("microsoft.com") || host.includes("kaspersky") || host.includes("eset") || host.includes("cloudflare")) {
    return SOURCE_CATEGORIES.security;
  }
  if (host.includes("teyit.org") || host.includes("dogrulukpayi") || host.includes("malumatfurus") || combined.includes("fact check")) {
    return SOURCE_CATEGORIES.factCheck;
  }
  if (host.includes("bit.ly") || host.includes("tinyurl") || host.includes("t.me") || host.includes("wa.me")) {
    return SOURCE_CATEGORIES.lowTrust;
  }
  if (host.includes("x.com") || host.includes("twitter") || host.includes("instagram") || host.includes("facebook") || host.includes("tiktok")) {
    return SOURCE_CATEGORIES.social;
  }
  if (host.includes("bbc.") || host.includes("reuters") || host.includes("aa.com.tr") || host.includes("trthaber") || host.includes("ntv") || host.includes("cnnturk")) {
    return SOURCE_CATEGORIES.establishedMedia;
  }
  return SOURCE_CATEGORIES.unknown;
}

function trustDefaults(category) {
  switch (category) {
    case SOURCE_CATEGORIES.official:
      return { baseTrust: 92, reason: "Resmî kurum/alan adı izi taşıyor." };
    case SOURCE_CATEGORIES.academic:
      return { baseTrust: 88, reason: "Akademik veya kurumsal bilgi kaynağı niteliğinde." };
    case SOURCE_CATEGORIES.security:
      return { baseTrust: 84, reason: "Siber güvenlik odaklı güvenilir kaynak izleri taşıyor." };
    case SOURCE_CATEGORIES.factCheck:
      return { baseTrust: 82, reason: "Doğrulama platformu veya fact-check kaynağı." };
    case SOURCE_CATEGORIES.establishedMedia:
      return { baseTrust: 66, reason: "Haber kaynağı; başka kaynaklarla karşılaştırılması önerilir." };
    case SOURCE_CATEGORIES.social:
      return { baseTrust: 34, reason: "Sosyal platform izi taşıyor; kanıt yerine bağlam sinyali sayılmalı." };
    case SOURCE_CATEGORIES.lowTrust:
      return { baseTrust: 22, reason: "Kısaltılmış/şüpheli bağlantı veya düşük güven sinyali var." };
    default:
      return { baseTrust: 45, reason: "Kaynak türü net değil; ek doğrulama gerekir." };
  }
}

async function consultAIReviewEndpoints(query, sources) {
  const endpoints = parseAIEndpoints();
  if (!endpoints.length) {
    return "Çoklu yapay zekâ görüşü için backend hazır; şu an kaynak güven puanı ve web araştırması kullanılıyor.";
  }

  const responses = await Promise.allSettled(endpoints.map((endpoint) => askAIEndpoint(endpoint, query, sources)));
  const summaries = responses
    .filter((item) => item.status === "fulfilled" && item.value)
    .map((item) => item.value);

  if (!summaries.length) {
    return "Yapay zekâ görüşleri alınamadı; rapor kaynak güven puanı ve manipülasyon ölçeğiyle oluşturuldu.";
  }

  return `Model destekli görüş özeti: ${summaries.join(" | ")}`;
}

function parseAIEndpoints() {
  const endpoints = [];

  if (process.env.OPENAI_API_KEY) {
    const models = String(process.env.OPENAI_REVIEW_MODELS || process.env.OPENAI_REVIEW_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini")
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean);

    models.forEach((model) => endpoints.push({
      name: process.env.OPENAI_REVIEW_NAME || "OpenAI",
      url: process.env.OPENAI_REVIEW_URL || "https://api.openai.com/v1/chat/completions",
      apiKey: process.env.OPENAI_API_KEY,
      model
    }));
  }

  if (!process.env.AI_REVIEW_ENDPOINTS) return endpoints;

  try {
    const parsed = JSON.parse(process.env.AI_REVIEW_ENDPOINTS);
    return Array.isArray(parsed) ? endpoints.concat(parsed) : endpoints;
  } catch {
    return endpoints;
  }
}

async function askAIEndpoint(endpoint, query, sources) {
  if (!endpoint.url || !endpoint.apiKey || !endpoint.model) return null;

  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${endpoint.apiKey}`
    },
    body: JSON.stringify({
      model: endpoint.model,
      messages: [
        {
          role: "system",
          content: [
            "Türkçe yanıt ver.",
            "Bir dijital içerik doğrulama danışmanı gibi davran.",
            "Kesin hüküm verme; kaynak kanıtı, manipülasyon işaretleri ve doğrulama ihtiyacını ayır.",
            "Yanıtı en fazla 4 kısa maddeyle ver.",
            "Kişisel veri, banka, sağlık veya acil güvenlik iddialarında resmi kaynak kontrolünü özellikle vurgula."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify({
            claim: query,
            availableSources: sources.slice(0, 5),
            requestedOutput: {
              manipulationSignals: "Varsa korku, aciliyet, sosyal kanıt, otorite iddiası gibi sinyaller",
              sourceConsistency: "Kaynaklar iddiayı destekliyor mu, zayıf mı, alakasız mı",
              userGuidance: "Kullanıcının bir sonraki doğrulama adımı"
            }
          })
        }
      ],
      temperature: 0.2,
      max_tokens: 260
    })
  });

  if (!response.ok) return null;
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || data.output_text || "";
  return text ? `${endpoint.name || "Model"} (${endpoint.model}): ${text}` : null;
}

function buildSummaryText(sources) {
  if (!sources.length) {
    return "Web araştırmasında anlamlı kaynak listesi bulunamadı. Sonuç, içerik sinyalleri ve manuel resmî kaynak kontrolüyle desteklenmelidir.";
  }

  const relevantSources = sources.filter((source) => source.relevanceScore >= 40);
  const official = relevantSources.filter((source) => [SOURCE_CATEGORIES.official, SOURCE_CATEGORIES.academic, SOURCE_CATEGORIES.security].includes(source.category)).length;
  const factCheck = relevantSources.filter((source) => source.category === SOURCE_CATEGORIES.factCheck).length;
  if (!relevantSources.length) {
    return `Araştırmada ${sources.length} kaynak izi bulundu ancak hiçbiri iddiayla güçlü biçimde eşleşmedi. Bu durum kesin doğrulama sağlamaz; resmî kurum, doğrulama platformu veya doğrudan kaynak kontrolü gerekir.`;
  }
  return `Araştırmada ${sources.length} kaynak izi bulundu. Bunların ${relevantSources.length} tanesi iddiayla anlamlı eşleşiyor. ${official} yüksek güvenli/resmî-akademik kaynak, ${factCheck} doğrulama kaynağı tespit edildi.`;
}

function relevance(query, text) {
  const stopwords = new Set(["hemen", "banka", "sizin", "bizim", "bunu", "şunu", "olan", "için", "gibi", "daha", "veya", "lütfen"]);
  const terms = [...new Set(query
    .toLocaleLowerCase("tr-TR")
    .split(/[^\p{L}\p{N}_.-]+/u)
    .filter((term) => term.length > 3 && !stopwords.has(term)))];
  if (!terms.length) return 35;
  const matches = terms.filter((term) => text.includes(term)).length;
  return clamp(Math.round((matches / terms.length) * 100), 0, 100);
}

function dedupeSources(sources) {
  const seen = new Set();
  return sources.filter((source) => {
    if (!source.url || seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

function safeHost(rawUrl) {
  try {
    return new URL(rawUrl).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

async function readJSON(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString("utf8");
  return rawBody ? JSON.parse(rawBody) : {};
}

function sendJSON(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

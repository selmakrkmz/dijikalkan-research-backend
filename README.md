# DijiKalkan Research Backend

This is a small optional research service for the `Kontrol Edelim` module. The iOS app keeps working without it; when `ResearchBackendURL` is set in `Info.plist`, the app sends research requests here.

## Run

```bash
cd ResearchBackend
npm start
```

Default endpoint:

```text
http://localhost:8787/research
```

For a physical iPhone, use the Mac's local network IP instead of `localhost`, for example:

```text
http://192.168.1.20:8787/research
```

## Request

```json
{
  "query": "Kontrol edilecek haber veya iddia",
  "locale": "tr-TR",
  "includeSourceScoring": true,
  "includeAIConsultation": true
}
```

## Response

```json
{
  "query": "...",
  "summaryText": "Araştırma özeti",
  "sources": [
    {
      "title": "Kaynak başlığı",
      "url": "https://...",
      "snippet": "Kısa açıklama",
      "trustScore": 82,
      "relevanceScore": 64,
      "category": "Doğrulama",
      "reason": "Doğrulama platformu veya fact-check kaynağı."
    }
  ],
  "aiConsultationSummary": "Yapay zekâ görüşleri eklenirse burada özetlenir.",
  "didFail": false
}
```

## Providers

- `TAVILY_API_KEY`: primary web search if available.
- `BRAVE_SEARCH_API_KEY`: secondary web search if available.
- DuckDuckGo Instant Answer: no-key fallback.
- Bing RSS fallback: no-key fallback when DuckDuckGo returns no useful source list.
- `OPENAI_API_KEY`: enables a model-supported review summary with OpenAI.
- `OPENAI_REVIEW_MODEL`: optional OpenAI model name. Defaults to `gpt-4o-mini` if not set.
- `OPENAI_REVIEW_MODELS`: optional comma-separated model list for multi-model review with the same OpenAI key.
- `AI_REVIEW_ENDPOINTS`: optional list of additional OpenAI-compatible model endpoints.

Example `AI_REVIEW_ENDPOINTS` value:

```json
[
  {
    "name": "Second Model",
    "url": "https://example.com/v1/chat/completions",
    "apiKey": "YOUR_KEY",
    "model": "model-name"
  }
]
```

Do not store API keys in the iOS app. Add them only as Render environment variables.

## Live Deploy With Render

The repository includes a `render.yaml` file for a simple Render deployment.

1. Create or open a Render account.
2. Choose **New > Blueprint**.
3. Connect this project repository.
4. Render will detect `render.yaml` and create `dijikalkan-research-backend`.
5. After deploy, open:

```text
https://YOUR-RENDER-APP.onrender.com/health
```

Expected response:

```json
{"ok":true,"service":"dijikalkan-research-backend"}
```

Then set the iOS `ResearchBackendURL` value to:

```text
https://YOUR-RENDER-APP.onrender.com/research
```

To enable model-supported review on Render:

1. Open the Render service.
2. Go to **Environment**.
3. Add `OPENAI_API_KEY`.
4. Optionally add `OPENAI_REVIEW_MODEL` or `OPENAI_REVIEW_MODELS`.
5. Add `AI_REVIEW_ENDPOINTS` only if you have another OpenAI-compatible provider.
6. Save changes and redeploy.

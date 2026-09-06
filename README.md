# Cody Gateway

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/damonto/cody)

An AI API gateway on Cloudflare Workers for Codex and OpenAI- and Anthropic-compatible clients. Manage multiple upstream services, model aliases, and client API keys in one configuration.

## Quick setup

You need Node.js 24 or newer and a Cloudflare account with Workers and KV.

From the project directory, install dependencies, sign in, and create a KV namespace:

```bash
npm install
npx wrangler login
npx wrangler kv namespace create CODY_CONFIG_KV
cp config.example.json config.json
```

Put the returned namespace ID in `wrangler.jsonc`, replacing the placeholder. Edit `config.json` with your upstream URLs, models, and keys, then deploy:

```bash
npm run config:validate -- config.json
npm run config:put -- config.json
npm run deploy
```

`config.json` contains credentials and is ignored by Git. Never commit it.

## Configuration

A minimal configuration with one upstream and one client key:

```json
{
  "$schema": "./config.schema.json",
  "services": [
    {
      "id": "primary",
      "base_url": "https://api.example.com/v1",
      "keys": [
        {
          "id": "default",
          "api_key": "sk-upstream",
          "priority": 100,
          "disabled": false
        }
      ],
      "priority": 100,
      "disabled": false,
      "models": ["grok-4.5"]
    }
  ],
  "api_keys": [
    {
      "id": "client",
      "api_key": "sk-client",
      "services": ["primary"]
    }
  ],
  "model_routes": {
    "gpt-5.6-sol": {
      "model": "grok-4.5"
    }
  }
}
```

Replace the example URL, model, and credentials with your own.

| Field          | What to configure                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `services`     | Upstream URLs, real model names, and upstream API keys. Higher `priority` is preferred; `disabled: true` disables a service or key. |
| `api_keys`     | Gateway client keys and the service IDs each client may access. Give each client a unique `id`.                                     |
| `model_routes` | Optional model aliases. The example exposes `gpt-5.6-sol` to clients and sends `grok-4.5` upstream.                                 |

For optional features:

- Set `services[].supports_websocket: true` for upstreams that support Responses WebSockets.
- Set `services[].supports_web_search: true` to use an upstream for Codex search. Alternatively, set `web_search` to `{"mode": "tavily", "api_key": "your-provider-key"}` or use mode `exa`.
- Make `gpt-image-2` available to the client to use Codex Image Gen.

See [config.example.json](config.example.json) for more examples and [config.schema.json](config.schema.json) for all options.

To apply configuration changes, validate again and run `npm run config:put -- config.json`. A Worker redeploy is not required.

## Use with Codex

Add this provider to `~/.codex/config.toml`, replacing `base_url` with your Worker URL and choosing a configured model:

```toml
model = "gpt-5.6-sol"
model_provider = "gateway"

[model_providers.gateway]
name = "Gateway"
base_url = "https://cody.example.workers.dev/v1"
wire_api = "responses"
http_headers = { "x-openai-actor-authorization" = "cody" }

[model_providers.gateway.auth]
command = "printenv"
args = ["OPENAI_API_KEY"]
timeout_ms = 5000
refresh_interval_ms = 300000
```

Start Codex with a gateway client key matching an `api_keys[].api_key` entry:

```bash
export OPENAI_API_KEY="your-gateway-client-key"
codex
```

This setup lets Codex refresh the model catalog and enables its Image Gen and search integrations when configured above.

Other clients can use the gateway's OpenAI or Anthropic endpoints with the same client key, supplied through `Authorization: Bearer` or `x-api-key`.

## Automatic deployment

Connect the repository to [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) and select `main` for automatic deployments. Use `npm test && npm run typecheck` as the build command and `npm run deploy` as the deploy command.

## Local development

```bash
npm run config:put -- config.json --local
npm run dev
```

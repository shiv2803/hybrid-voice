# Hybrid Voice Assistant

Push-to-talk voice assistant for the web (Chrome). Runs prompts on-device with Gemini Nano when available and falls back to the cloud when it isn't, or when the request is too large.

Built for the **#BuildHybridAI 2026** hackathon (Firebase AI Logic).

## Live demo

https://hybrid-voice.web.app

- Repo: https://github.com/shiv2803/hybrid-voice
- Firebase project: `hybrid-voice`
- License: Apache-2.0

## Target audience

Hands-free workers and offline users — anyone who needs a voice assistant that keeps working without connectivity and keeps data local when possible.

## Core problem

Voice assistants either fail without connectivity or send every request to the cloud.

## Pipeline

```
Mic → Speech-to-Text (Web Speech API) → Firebase AI Logic hybrid inference → Text-to-Speech (speechSynthesis)
```

Every answer shows a visible **On-device** / **Cloud** badge.

## Features

- Visible "On-device" / "Cloud" badge on every answer
- Typed-input fallback that works without a microphone
- Routing rule: on-device first; cloud for long or complex input, or when the local model is unavailable
- Routing thresholds come from Firebase Remote Config, so they can be tuned without a redeploy
- Conversation history in Firestore, private to the anonymous user
- Firebase App Check (Fraud Defense / reCAPTCHA Enterprise), Anonymous Auth, Firestore, Remote Config, Hosting

## Run locally

```bash
npm install
npm run serve
```

Then open the printed URL in Chrome. Allow microphone access.

On-device inference needs Chrome 139+ on desktop with the Prompt API enabled at
`chrome://flags/#prompt-api-for-gemini-nano-multimodal-input`. Without it the app
reports "On-device: unavailable" and routes to the cloud.

## Test

```bash
npm test
```

## Deploy

```bash
firebase deploy --only hosting,firestore:rules,remoteconfig --project hybrid-voice
```

## Configuration

Remote Config parameters (defaults in `remoteconfig.template.json`):

| Parameter | Default | Meaning |
|---|---|---|
| `maxOnDeviceChars` | 240 | Inputs longer than this skip the on-device model |
| `maxOnDeviceWords` | 45 | Inputs longer than this skip the on-device model |
| `cloudModel` | gemini-3.8-flash | Model used for cloud inference |

## License

Apache-2.0 — see [LICENSE](LICENSE).

# Hackathon submission checklist

Status snapshot: 21 October 2026. Confirm the current [official rules](https://amazonappdev2026.devpost.com/rules) and [FAQ](https://amazonappdev2026.devpost.com/details/faqs) before submitting. The currently published deadline is **23 October 2026 at 12:00 p.m. Pacific Time**.

## Project readiness

- [x] Working React/Vite frontend and Node/Express backend source is present.
- [x] README documents clean install, run, environment, GitHub App setup, tests, security and limitations.
- [x] MIT license is included for a public open-source repository.
- [x] Secret and local-data patterns are ignored in `.gitignore`; local `.env` and `data/` stay untracked.
- [x] Automated tests, type check and production build pass after a clean install.
- [ ] Create/choose a GitHub remote and confirm which files are actually tracked. This workspace currently has no `.git` metadata, so tracked-file/remote review cannot be performed here.
- [ ] Choose public licensed repository or private repository shared with the listed judges/reviewer and ensure invitations are accepted before the deadline.
- [ ] Add real screenshots captured from the running app; README currently contains an explicit placeholder.
- [ ] If the project existed before the hackathon submission window, accurately describe and demonstrate the substantial updates made during the event.

## Alexa+ track fit and disclosure

- [x] Intended submission route: **simulated Alexa+ experience in a web app using the project's own agentic tools**. The published rules permit this option without a real Alexa Skill/MCP runtime hook, but require the simulation source in the repository and a video that clearly shows the simulated experience.
- [x] Accurate disclosure: LaunchPilot is a text-based web simulation. It is not an official Alexa product, Alexa+ Skill, Alexa device integration or Amazon API integration.
- [ ] Make the simulated-experience framing obvious in the recorded demo and Devpost description. The app currently demonstrates an agentic web workflow, not voice interaction or Amazon platform APIs.
- [ ] Select the Alexa+ primary track in Devpost; select no AWS Builder or Open Source mini-challenge unless their separate criteria are actually met.

## Live integration evidence

- [x] Deterministic GitHub HTTP fixtures verify tool approval, issue creation, independent read-back, duplicate detection and safe outcomes in automated tests.
- [ ] Configure valid GitHub App credentials and run the complete live test against a disposable repository. No live authorization or live write was performed during this audit.
- [ ] Do not present mock-mode fixture results as live. Keep the visible mock label in the video whenever using fallback mode.

## Devpost form fields

- [ ] Project name: **LaunchPilot AI**.
- [ ] Track: **Alexa+**, simulated-experience option.
- [ ] Description: explain the developer readiness problem, ordered plan, permission-aware tool calls, exact-payload approval and independent verification.
- [ ] Repository URL: provide the GitHub remote after it exists; the current workspace is not a Git checkout.
- [ ] Demo URL: provide a public YouTube/Vimeo video shorter than 3 minutes.
- [ ] Product Feedback: answer the form's questions for each tool/API/SDK actually used: what it is used for, what worked, what needs work, zero-to-hello-world onboarding, and whether you would build with it again and why.
- [ ] Feedback honesty draft: GitHub App/REST code is implemented and HTTP-fixture tested, but live onboarding/performance has not yet been observed. The OpenAI provider is configurable but no live model call was demonstrated. No Amazon developer API/SDK was used because this entry uses the web-simulation path. Add firsthand observations only after testing; do not invent “worked well” or “would use again” responses.
- [ ] Accessibility: use captions, readable zoom, high-contrast evidence/status text and keyboard-accessible interactions in the demo. Verify the recorded video remains understandable without audio.
- [ ] Confirm all claims in the text, screenshots and video match the tested build and selected mode.

## Deployment decision

No deployment was configured. The current official FAQ says a locally runnable public repository plus demo video is sufficient for the Alexa+ track. This app has a single-user encrypted credential vault but no user authentication or tenant isolation, so exposing its backend publicly is not safe. Use the documented local setup for judging; revisit a hosted frontend/backend only after adding an appropriate identity and multi-user credential boundary. Never put GitHub or LLM secrets in a `VITE_` variable.

## Current validation snapshot

- `npm ci`: succeeded; 240 packages installed and npm audit found 0 vulnerabilities.
- `npm test`: 34 tests passed across 4 files, including frontend API response handling and GitHub HTTP fixtures.
- `npm run typecheck`: passed.
- `npm run build`: passed; backend TypeScript and Vite production frontend compiled.
- `npm audit`: 0 vulnerabilities after upgrading Tailwind CSS to v4 and using its Vite integration.
- Lint/format scripts are not configured in `package.json`.
- Production preview and API smoke checks returned HTTP 200; a mock read-only run completed with stored events/evidence, and the issue approval endpoint recorded a rejection without executing the write. Live GitHub and OpenAI credentials were unavailable; only mock/local behavior and deterministic HTTP fixtures were tested. Browser-based visual regression testing was unavailable in this workspace.

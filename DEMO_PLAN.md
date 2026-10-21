# LaunchPilot AI demo plan

Target length: **2:50**. Show the running web app as a text-based Alexa+ experience simulation, not as an Alexa Skill or an official Amazon integration. The hackathon rules allow a web-app simulation using an entrant's own agentic tools; the video must clearly show that simulation functioning. Use only footage and music you have rights to publish.

## Spoken script and screen actions

| Time | On-screen action | Spoken script |
| --- | --- | --- |
| 0:00–0:15 | Show LaunchPilot's real overview screen; keep the browser and app visible. | “Preparing a developer project for a hackathon means checking more than a README. LaunchPilot turns that goal into a reviewable plan and evidence-backed GitHub work.” |
| 0:15–0:35 | Enter: “Prepare this repository for hackathon submission. Check the README, setup, license, demo instructions, open issues and documentation gaps. Propose one issue for the most important gap, but do not make any change until I approve it.” | “I describe the outcome and explicitly set the boundary: investigate first, then ask me before any external write.” |
| 0:35–1:00 | In a live run, connect the GitHub App and select a dedicated test repository. Show the connected account, repository name, default branch and inspection steps/results. | “The server checks that this repository is authorized, reads its metadata, permitted files and issue list, and ties each finding to repository evidence. Read-only inspection does not change the repo.” |
| 1:00–1:30 | Open the plan and approval panel. Expand the exact payload. Point out repository, action, target, permission and expected effect. Select Reject in the rejection take, then reset with a fresh run for the approval take if recording both. | “Before a write, LaunchPilot shows the exact issue title and body, target repository, required permission and expected effect. Approval is bound to this exact payload; a changed proposal must be reviewed again.” |
| 1:30–2:00 | On the fresh run, click Approve. Show the execution event and the subsequent GitHub issue read-back. Open the verified GitHub URL in a separate tab. | “After approval, the backend creates the issue. It does not trust the model's narration: it fetches the issue from GitHub and verifies the returned resource before calling it verified.” |
| 2:00–2:25 | Expand verification evidence and timestamp. Briefly show a failed or inconclusive state using a deliberately disconnected test environment only if it is safe; otherwise show the recorded simulated label. | “The result includes a timestamp and resource evidence. If GitHub cannot be read back—or if we are in mock mode—the app says failed or inconclusive. A fixture is never presented as a real GitHub operation.” |
| 2:25–2:50 | Show the high-level architecture or README diagram, then return to the workspace. | “LaunchPilot combines a conversational web interface, a typed server-side tool registry, explicit approval gates and independent verification. This is a web simulation of an agentic Alexa+ experience, not a real Alexa+ Skill or device integration.” |

## Recording setup

1. Use a dedicated, disposable GitHub test repository with a deliberately incomplete but non-sensitive README. Do not use a personal or production repository.
2. Configure the GitHub App with Metadata read, Contents read, Issues read/write, and Pull requests read. Leave optional Contents and Pull requests write disabled unless the demo specifically needs the documentation PR feature.
3. Set up `.env` from `.env.example`; keep the client secret and encryption key server-side. Use `LLM_MODE=mock` if no provider key is available, and say so. GitHub live mode is separate from LLM mode.
4. Start with `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, then `npm run dev`. Confirm `/api/health`, OAuth, repository selection, actual inspection, issue approval, issue read-back, result URL, and disconnection before recording.
5. Use a fresh run for every write take. Confirm the exact action marker prevents duplicates. Remove test resources from the dedicated repository manually after recording if desired.
6. Record the actual desktop browser at readable zoom, with the app's live/mock labels visible. Keep the video under three minutes and captions readable.

## Backup and stop conditions

If GitHub App credentials or a safe test repository are unavailable, record a clearly labeled mock-mode interface walkthrough. Do not narrate or caption it as a live GitHub write, do not show a fabricated GitHub result, and do not claim successful live verification. State that live acceptance remains untested. If OAuth, permissions, issue creation or read-back fails, show the truthful error or stop the live take and use the labeled mock walkthrough.

## Must pass before a live recording

- GitHub App OAuth succeeds and repository list contains the test repo.
- Repository metadata, README and issue reads come from actual GitHub API responses.
- Proposed action payload and permission are correct and visible.
- Reject makes zero write requests; approval causes one issue creation.
- Read-back fetch confirms the created issue and the canonical URL opens.
- Duplicate retry returns the same issue instead of creating another.
- Permission denial, invalid repository and GitHub/network failure display safe messages.
- Mock mode remains labeled simulated/inconclusive.
- The final cut is under 3:00 and uploaded publicly to YouTube or Vimeo with the URL entered in Devpost.

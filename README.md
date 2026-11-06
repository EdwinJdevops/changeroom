# ChangeRoom

ChangeRoom lets a release reviewer and a Codex agent finish a staging promotion in a Switch room. Codex reviews release evidence and identifies the candidate by SHA-256. A human approves one proposal. The controller reads the decision from Switch, checks the candidate and room instructions again, then promotes the reviewed bytes in a local staging ledger and posts the receipt in the room.

## Run the local checks

Install Node 24 and run `node --test` in this directory. The test binds to loopback and uses a mock Switch HTTP server and real SQLite. It verifies that agent impersonation and changed room instructions leave staging untouched, that the authorized decision changes the staging pointer, and that replay after reopening the database leaves one receipt. A second check covers a superseded request. Both ran successfully on Windows. Live Switch, Mattermost identity mapping, and template import still need to be exercised.

## Connect the room

1. Follow the [Switch quickstart](https://docs.switchagents.ai/switch-rooms/getting-started). Start the local server from Switch Console or join a server you already operate. Connect its Mattermost bridge and confirm that the Codex provider answers a human in chat.
2. Import `changeroom.template.yaml` from Console Templates. Select Mattermost and run it. If your build rejects the template, create `changeroom-reviewer` with its instructions and invite it into a new Mattermost-backed room manually.
3. Register a dedicated controller identity using the Switch agent API and a registration token from the server operator. The request is `POST /agents` with the registration token as bearer and JSON below. Keep the returned `api_key` in a local environment variable. Invite the registered agent into the same room. Use the agent API base address for the deployment, which may differ from the Console's web address. [Agent protocol](https://docs.switchagents.ai/switch-rooms/internals/agent-protocol)

```json
{
  "name": "changeroom-controller",
  "description": "Applies approved staging promotions and posts receipts",
  "connector_type": "changeroom",
  "integration_profile": {
    "connection_model": "session_passive",
    "message_exchange": true,
    "pre_invocation_mediation": [],
    "post_invocation_mediation": [],
    "event_reporting": []
  }
}
```

4. Set these variables in the controller's shell. Enter the key through your local secret workflow. Keep it and the ledger outside the coding agent's working directory. Use one controller instance per demo room.

| Variable | Value |
|---|---|
| `SWITCH_URL` | Agent API base, HTTPS or local HTTP |
| `SWITCH_AGENT_ID` | Controller registration `id` |
| `SWITCH_AGENT_KEY` | Controller registration `api_key` |
| `SWITCH_ROOM_ID` | Switch room UUID |
| `CHANGE_PROPOSER` | Codex agent's opaque Switch sender ID |
| `CHANGE_APPROVER` | Human reviewer's opaque Switch sender ID |
| `CHANGE_DB` | Optional SQLite file path, default `changeroom.sqlite` |
| `CHANGE_ARTIFACT_DIR` | Folder containing the small `<version>.txt` release files, default `releases` |

5. Have the human and agent each post the exact text `change identity` in the dedicated room. Run `node controller.mjs --identify` within five minutes and match the displayed IDs to those messages. Configure those distinct IDs as proposer and approver. If the human message is labeled `platform` or appears on someone's behalf, confirm the bridge account is linked and repeat. The controller declines such messages.
6. Run `node controller.mjs` and post a fresh proposal. The controller reads messages and current instructions from Switch using the dedicated member identity. Keep the demo under 100 timeline entries from startup. A truncated timeline or API failure stops the controller. Restart and post a new proposal to resume a failed demo.

## Record the demo

1. Create `1.2.3.txt` in the candidate folder. Give the agent read access to the file and tell it the absolute path. Ask `@changeroom-reviewer` to review the candidate with a passing test summary and rollback target `1.2.2`. The agent posts its evidence and `change propose 1.2.3 <sha256>`.
2. Let the controller publish the exact approval command. Change the candidate contents while keeping the filename. Send the old command as the human reviewer. Show the refusal and the unchanged staging pointer.
3. Ask Codex to review the replacement. Approve the fresh request. Show the version, reviewed hash and receipt in Mattermost and the ledger, then replay the same approval. Use `node controller.mjs --status` in another terminal with the same room ID and database path to show the pointer before and after.
4. Capture the room transcript and terminal test output. Submit the public repository, short demo video, and README by November 7, 2026 at 17:29 UTC. [Organizer schedule](https://www.wemakedevs.org/hackathons/switch/schedule) · [Submission portal](https://www.wemakedevs.org/hackathons/switch/submit)

The staging pointer and approval are committed in the same SQLite transaction. The controller checks a hash of the current instruction text immediately before applying the local change. This catches changed text at the time of the check. Switch room edits and the SQLite transaction are independent, so this prototype cannot rule out a simultaneous edit or detect an edit followed by a restoration of identical text. A crash between publishing a receipt and marking it sent may repeat the receipt, while the promotion stays recorded once. The controller trusts Switch's server-supplied sender identity and assumes its database and key are under operator control. Use a dedicated demo environment.

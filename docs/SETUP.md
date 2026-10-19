# Setup: Alexa-hosted development skill

These steps put Complexity on your own Echo devices in the Development stage.
No certification is needed.

Current skill: `amzn1.ask.skill.9dd8cd52-c96b-421f-9c05-d33f7985e033`
(development stage). The skill runs on Alexa-hosted's **nodejs16.x** runtime.

## 1. ASK CLI

```sh
npm i -g ask-cli@2.30.7
ask configure        # sign in with your Amazon Developer account
```

Use the same Amazon account your Echo Show is registered to.

## 2. Create the Alexa-hosted skill (one time)

Create the skill in the Developer Console. `ask new` can fail when its
sign-in captcha won't load.

Developer Console → Create Skill:
- Name: Complexity
- Type: Other → Custom
- Hosting: Alexa-hosted (Node.js), US East (N. Virginia)
- Template: Start from scratch

Then link this repo to the skill:

```sh
# ask-resources.json is committed; .ask/ask-states.json holds the skill ID (gitignored)
mkdir -p .ask && cat > .ask/ask-states.json <<'EOF'
{ "askcliStatesVersion": "2020-03-31",
  "profiles": { "default": { "skillId": "<skill id>",
    "skillInfrastructure": { "@ask-cli/hosted-skill-deployer": { "deployState": {} } } } } }
EOF
ask smapi get-alexa-hosted-skill-metadata -s <skill id>     # prints the CodeCommit URL
git remote add alexa <CodeCommit URL>
# The empty helper stops macOS Keychain from caching the short-lived
# CodeCommit credentials (stale ones cause HTTP 403 on later pushes).
git config --add "credential.<CodeCommit URL>.helper" ''
git config --add "credential.<CodeCommit URL>.helper" '!ask util git-credentials-helper'
git fetch alexa
```

## 3. Deploy

**Manifest and voice model** go through SMAPI. `skill.json` already has the
hosted Lambda endpoints and the SKILL_DISABLED subscription.

```sh
S=<skill id>
ask smapi update-skill-manifest -s $S -g development --manifest file:skill-package/skill.json
ask smapi set-interaction-model -s $S -g development -l en-US \
  --interaction-model file:skill-package/interactionModels/custom/en-US.json
ask smapi get-skill-status -s $S     # wait for SUCCEEDED
```

**Code** goes by git push to the hosted repo's `master` branch, which deploys
to Development. That repo has its own history (the template's initial
commit), so we push a commit containing this repo's tree on top of it. That
keeps the push a fast-forward:

```sh
npm run deploy:code     # from lambda/, see scripts/deploy-code.sh
```

Don't use `ask deploy` here. For hosted skills it pushes to the `origin`
remote, which in this repo is GitHub.

## 4. Enable testing and try it

Developer Console → Test → set testing to **Development**. On the Echo Show:

> "Alexa, open complexity player"

The screen shows a 4-character code. Enter it at <https://plex.tv/link>,
signed in to the Plex account that owns or shares the server. The screen
updates within about 5 seconds.

Then try: "Alexa, ask complexity player to play The Bear", or tap a server or poster on screen.

## Requirements on the Plex side

- Settings → Remote Access must say **Fully accessible outside your network**.
  The skill backend runs in AWS and talks to the server over the internet.
- The Echo plays video directly from the server, so its address and port
  (normally 32400) must be reachable from the Echo too.

## Local development

```sh
cd lambda
npm install
npm test     # unit and end-to-end handler tests against a fake plex.tv
npx -y -p node@16.20.2 node --test test/plex.test.js test/skill.test.js test/http.test.js   # hosted runtime version
```

## Data stored

Data is stored per Amazon account, in the skill's DynamoDB table. AWS encrypts
it at rest.

- A random Plex client ID and an Ed25519 device key.
- The Plex token: a legacy token, because PMS doesn't accept Plex's newer JWTs yet.
- The selected server and its connection URIs.

All of it is deleted when you say "unlink Plex" or disable the skill. You can
also revoke access at any time from plex.tv → Account → Authorized Devices
(the entry named "Complexity (Alexa)").

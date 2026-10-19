# Setup: Alexa-hosted development skill

These steps put Complexity on your own Echo devices in the Development stage.
No certification is needed.

## 1. ASK CLI

```sh
npm i -g ask-cli@2.30.7
ask configure        # opens a browser; sign in with your Amazon Developer account
```

Use the same Amazon account your Echo Show is registered to.

## 2. Create the Alexa-hosted skill (one time)

```sh
cd ~/Documents
ask new
#   Choose a modeling stack: Interaction Model
#   Runtime: Node.js
#   Hosting: Alexa-hosted skills
#   Locale: en-US · Region: US East (N. Virginia)
#   Skill name: Complexity · Template: Hello World (it gets replaced)
```

This creates a folder that is a git clone of the skill's hosted repository
(AWS CodeCommit). Note its remote URL and `ask-resources.json`, then point this
repo at it:

```sh
cd ~/Documents/Complexity
cp ../Complexity-hosted/ask-resources.json .
cp -R ../Complexity-hosted/.ask .            # skill ID lives here (gitignored)
git remote add alexa "$(git -C ../Complexity-hosted remote get-url origin)"
```

## 3. Deploy

Alexa-hosted skills deploy on push. `master` goes to the Development stage:

```sh
git push alexa main:master
```

The hosted build runs `npm install` in `lambda/` and deploys `lambda/index.js`.
The interaction model in `skill-package/` is built on the same push.

Check: Developer Console → Complexity → Code tab shows the new files;
Build tab shows the model built.

## 4. Enable testing and try it

Developer Console → Test → set testing to **Development**. On the Echo Show:

> "Alexa, open complexity"

The screen shows a 4-character code. Enter it at <https://plex.tv/link>,
signed in to the Plex account that owns or shares the server. The screen
updates within about 5 seconds.

Then try: "Alexa, ask complexity which server am I using".

## 5. Subscribe to SkillDisabled (one time)

The code already deletes stored data on `AlexaSkillEvent.SkillDisabled`. Alexa
only sends that event once the manifest subscribes to it, and the subscription
needs the hosted Lambda ARN. That ARN only exists after step 2, so the
subscription isn't in `skill.json` yet.

1. Find the ARN with `ask smapi get-skill-manifest -s <skillId>` (look at
   `apis.custom.endpoint.uri`).
2. Add this block to `manifest` in `skill-package/skill.json`, then push:

```json
"events": {
  "endpoint": { "uri": "<hosted lambda ARN>" },
  "subscriptions": [{ "eventName": "SKILL_DISABLED" }]
}
```

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
```

## Data stored

Data is stored per Amazon account, in the skill's DynamoDB table. AWS encrypts
it at rest.

- A random Plex client ID and an Ed25519 device key.
- The Plex token: a JWT, refreshed about weekly through the nonce flow.
- The selected server and its connection URIs.

All of it is deleted when you say "unlink Plex" or disable the skill. You can
also revoke access at any time from plex.tv → Account → Authorized Devices
(the entry named "Complexity (Alexa)").

# Privacy Policy

Complexity Player (the "Complexity" Alexa skill) collects only what it needs to
play your own Plex library on your Echo device. It does not sell or share your
data, show ads, or use analytics or tracking.

## What is stored

The skill stores this per Amazon account, keyed by the anonymous user ID that
Alexa gives each skill:

- **Plex sign-in:** the Plex access token you approve at plex.tv/link, a random
  device identifier and a device key created for this skill, and your Plex
  username (shown on screen).
- **Server choice:** the name and addresses of the Plex server you picked.
- **Playback state:** what is playing and the current position, while you
  watch.

It is kept in the skill's Amazon DynamoDB table (Alexa-hosted, encrypted at
rest by AWS).

The skill never sees or stores your Plex password. The sign-in uses Plex's own
link-code page.

## Where data goes

- **Plex (plex.tv and your Plex Media Server):** to sign in, find your
  servers, search your library, stream video, and save your watch progress so
  Continue Watching stays in sync.
- **Amazon:** your requests go through Alexa as with any skill. See
  [Amazon's Alexa privacy notice](https://www.amazon.com/alexaprivacy).

Video streams go straight from your Plex server to your Echo device. They do
not pass through the skill.

## Diagnostics

While the skill is in development it keeps a short rolling log of the last 40
requests to help fix problems on real devices: request type, intent name,
screen events, timings and error messages. It contains no Plex tokens, stream
links, or user or device identifiers. The log will be removed before any
public release.

## Deleting your data

Any of these deletes everything the skill stored for your account:

- Say "Alexa, ask complexity player to unlink Plex".
- Disable the skill in the Alexa app.

You can also revoke the skill's Plex access at any time: plex.tv → Account →
Authorized Devices → "Complexity (Alexa)".

## Contact

Questions: open an issue on the project's GitHub repository or contact the
developer (CAMx-1).

*Last updated: October 19, 2026*

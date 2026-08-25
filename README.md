# ReqRunner

A lightweight inline REST client for VS Code. Write requests in a plain text
file, click `▶ Send Request`, read the response next to your code.

## Why ReqRunner

Testing an endpoint should not mean leaving the editor, signing into an account,
or waiting for a desktop app to start. ReqRunner keeps the whole loop inside VS
Code:

- Requests live in `.reqrunner` files you can commit next to the code they exercise.
- No account, no cloud sync, no telemetry.
- No third-party HTTP client. Requests go out through Node's built-in `http` and
  `https` modules that ship with VS Code.
- Small surface area: a parser, a variable resolver, a request runner and a
  response view.

## Features

- `▶ Send Request` CodeLens above every `###` block.
- `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` and `OPTIONS`.
- Custom headers and request bodies.
- `{{variable}}` substitution from `.reqrunner.env.json` or from `@name = value`
  lines in the document itself.
- Response view with status, response time, size, response headers, and the body
  pretty-printed when it is JSON.
- Plain-text, HTML and XML responses shown as-is; binary payloads reported rather
  than dumped.
- Saved Requests sidebar listing every `.reqrunner` file and the requests inside it.
- Status bar entry that creates a new request file from a starter template.
- Failures — bad URL, unknown host, refused connection, timeout, invalid JSON,
  TLS problems — are reported in the response view instead of crashing anything.

## Installation

From the Marketplace:

1. Open the Extensions view (`Ctrl+Shift+X`).
2. Search for **ReqRunner**.
3. Click **Install**.

Or from the command line:

```bash
code --install-extension sankara-ms.reqrunner
```

From a local build:

```bash
npm install
npm run compile
npx vsce package
code --install-extension reqrunner-1.0.0.vsix
```

## Quick Start

1. Click **ReqRunner Ready** in the status bar. A new file opens with a working
   template.
2. Save it as `requests.reqrunner`.
3. Click `▶ Send Request` above the first block.
4. The response opens beside the editor.

Keyboard shortcut: `Ctrl+Alt+R` (`Cmd+Alt+R` on macOS) sends the request the
cursor is in.

## `.reqrunner` syntax

A file is a list of blocks separated by `###`. The text after `###` is the
request name shown in the CodeLens tooltip and the sidebar.

```text
### Get all bookings

GET https://api.example.com/bookings

Authorization: Bearer {{token}}

### Create booking

POST https://api.example.com/bookings

Content-Type: application/json

{
  "customer": "John",
  "route": "Chennai-Bangalore"
}
```

Rules:

- The first non-blank, non-comment line of a block is the request line:
  `METHOD URL`. If the method is omitted, `GET` is assumed.
- Lines shaped like `Name: value` after the request line are headers. Blank lines
  between them are ignored, so both the spaced style above and the compact style
  below parse the same way.
- The first line that is neither blank nor a header starts the body. Everything
  after it, blank lines included, is the body.
- `#` and `//` start a comment. `###` is always a block separator, never a comment.
- `@name = value` declares a variable. Before the first `###` it applies to the
  whole file; inside a block it applies to that block only.

Compact style:

```text
### Get users
GET https://api.example.com/users
Accept: application/json
```

## Environment variables

Create `.reqrunner.env.json` next to your request file, or anywhere above it in
the folder tree:

```json
{
  "baseUrl": "https://api.example.com",
  "token": "your-token"
}
```

Then reference the values with `{{name}}`:

```text
GET {{baseUrl}}/bookings

Authorization: Bearer {{token}}
```

Details:

- Placeholders work in the URL, header names, header values and the body.
- Values may reference other values, e.g. `"usersUrl": "{{baseUrl}}/users"`.
- Lookup walks up from the request file to the workspace root. A file closer to
  the request wins, so a folder can override project-wide defaults.
- `@name = value` in the document overrides the env file.
- Run **ReqRunner: Create Environment File** from the Command Palette to
  scaffold one.
- Keep secrets out of source control by adding `.reqrunner.env.json` to
  `.gitignore`.

## Response handling

The response view shows:

- Status code and status text, colour-coded by class.
- Response time and payload size.
- Response headers in the order they arrived.
- The body, pretty-printed when it is valid JSON.
- A **Request** tab showing exactly what was sent.

`Authorization`, `Cookie` and `Set-Cookie` values are masked in the view so a
screen share or screenshot does not leak them.

Non-2xx responses are normal results, not errors: a 404 body is displayed like
any other. Only transport failures are reported as errors, with a short list of
things to check.

## Troubleshooting

**`▶ Send Request` does not appear**
The file must use the `.reqrunner` extension and the block must contain a
readable request line. Check that `reqrunner.showCodeLens` is enabled.

**`Unresolved variable(s) in the URL`**
The placeholder has no value. Add it to `.reqrunner.env.json` or declare
`@name = value` in the document. The error message lists which files were checked.

**`Host not found`**
A DNS failure. Check the host name and your connection.

**`Connection refused`**
Nothing is listening on that host and port. For local work, confirm the port.

**`Request timed out`**
Raise `reqrunner.timeout` (milliseconds, default 30000).

**TLS certificate could not be verified**
Expected against a self-signed local server. Set
`reqrunner.rejectUnauthorized` to `false` for trusted development hosts only.

**Response declared JSON but could not be parsed**
The server sent a `json` content type with a body that is not valid JSON. The
raw text is shown unchanged so you can see what arrived.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `reqrunner.timeout` | `30000` | Request timeout in milliseconds. |
| `reqrunner.followRedirects` | `true` | Follow 3xx responses. |
| `reqrunner.maxRedirects` | `5` | Redirect limit. |
| `reqrunner.rejectUnauthorized` | `true` | Enforce TLS certificate validation. |
| `reqrunner.envFileName` | `.reqrunner.env.json` | Environment file name to look for. |
| `reqrunner.showCodeLens` | `true` | Show the Send Request lens. |

## Roadmap

Under consideration for later releases:

- Request history with replay.
- Named environments in a single env file.
- Copy as cURL.
- Response assertions for quick smoke checks.
- Form and multipart bodies.

GraphQL, gRPC, OAuth2 automation and cloud sync are deliberately out of scope.

## Contributing

Issues and pull requests are welcome at
[github.com/sankara-ms/reqrunner](https://github.com/sankara-ms/reqrunner).

```bash
npm install
npm run compile          # type-check + bundle
npm test                 # unit tests
npm run test:integration # extension host tests
```

Please add a test with any bug fix that can be covered automatically.

## Support

ReqRunner is free, has no paid tier, and shows no ads or prompts. If it saves you
time, sponsorship is optional and appreciated:
[github.com/sponsors/sankara-ms](https://github.com/sponsors/sankara-ms).

## Author

Built by [Sankara MS](https://github.com/sankara-ms).

## License

[MIT](LICENSE)

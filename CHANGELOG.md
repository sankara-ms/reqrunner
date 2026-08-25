# Changelog

All notable changes to ReqRunner are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-08-25

First release.

### Added

- `.reqrunner` file format with `###` request blocks.
- `▶ Send Request` CodeLens above every request block.
- Request execution over Node's native `http` / `https` modules, with support for
  `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` and `OPTIONS`.
- Custom headers and request bodies.
- `{{variable}}` substitution from `.reqrunner.env.json` and from `@name = value`
  document variables, including nested references.
- Response webview showing status, response time, payload size, response headers,
  the pretty-printed body, and the request that was sent.
- Masking of `Authorization`, `Cookie` and `Set-Cookie` values in the response view.
- Saved Requests sidebar listing every `.reqrunner` file in the workspace.
- Status bar entry that creates a new `.reqrunner` file from a starter template.
- `ReqRunner: Create Environment File` command.
- Syntax highlighting and folding for `.reqrunner` files.
- Settings for timeout, redirect handling, TLS verification, env file name and
  CodeLens visibility.
- Gzip, deflate and Brotli response decoding.
- Error reporting for invalid URLs, unknown hosts, refused connections, timeouts,
  redirect loops, TLS failures and malformed JSON payloads.

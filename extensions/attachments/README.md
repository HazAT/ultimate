Attachments: a file attached in the composer that is not an inline image (a PDF, a zip, an iPhone HEIC) is uploaded to the host, and the prompt references its path for the agent to read with its tools.

## How it works

- **Upload.** The composer's paperclip, paste and drop hand such a file to the `upload` action (`{ name, data: base64 }`
  → `{ path }`) as soon as it is attached; files up to 8 MB attach, what fits the 12 MB action request. It works from
  any device that reaches the UI, a phone over the tailnet included.
- **Storage.** `<home>/attachments/<ms>-<id>/<name>`: the project's home, outside every checkout, so a file never
  blocks a landing. The name keeps only its last segment, without control characters or backticks.
- **Retention.** Each time the harness opens, folders older than 30 days are deleted. A message that referenced one
  keeps its chip, dimmed, noting the file was removed.
- **Reference.** Sending appends one line per file to the prompt text:
  ``Attached file: `report.pdf` (1.2 MB, application/pdf) at `/…/attachments/…/report.pdf` ``. It is plain text, so it
  survives replay, compaction, merged steers and recall; the composer and the sent message show it as a file chip, never
  the raw line.

The extension provides the SDK's `FileUpload` point; without it, only images attach.

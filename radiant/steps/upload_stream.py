"""upload_stream step — stream a pipe's output straight to a remote via ``rclone rcat``.

A pipe **sink** (final stage): it reads stdin and writes it to a remote object, so
an encode can go to the bucket without ever landing a local file — e.g.
``braw_decode | ffmpeg | upload_stream``. Trade-off vs the file-based ``upload``:
no intermediate on disk, but the whole pipe runs as one unit and re-runs each time
(there's no local artifact to resume from).

Pipe-only — ``rcat`` needs a stdin stream, so ``run`` (standalone) raises with guidance.
"""

import sys
from pathlib import Path

from ..media import public_url
from .base import Output, Param, Step, StepContext


def _dest(remote: str, filename: str) -> str:
    return remote.rstrip("/") + "/" + filename


def _acl_args(remote: str, public: bool) -> list[str]:
    if not public:
        return []
    r = remote.lower()
    if r.startswith("s3"):
        return ["--s3-acl", "public-read"]
    if r.startswith("gs"):
        return ["--gcs-object-acl", "publicRead"]
    sys.exit(f"Error: public upload is not supported for remote '{remote}' (expected s3: or gs:)")


class UploadStreamStep(Step):
    action = "upload_stream"
    summary = "Stream a pipe's output straight to a remote via `rclone rcat` (pipe-only sink)."
    params = (
        Param("remote", "rclone remote directory, e.g. 'gs:bucket/video/reels/'.", required=True),
        Param("filename", "Object name to write at the remote.", required=True),
        Param("public", "Set a public-read ACL and return the public URL.",
              type="bool", default=False),
    )
    outputs = (
        Output("url", "Public URL when public:true, else the remote destination."),
    )

    def run(self, params: dict, ctx: StepContext) -> dict:
        raise ValueError(
            "upload_stream is a pipe-only sink (it reads a stdin stream via `rclone rcat`); "
            "use it as the last stage of a `pipe`, or use `upload` for a local file."
        )

    def command(self, params: dict, ctx: StepContext, *, upstream: dict | None = None,
                out: Path | None = None, is_last: bool = False) -> tuple[list, dict]:
        if not is_last:
            raise ValueError("upload_stream must be the final (sink) stage of a pipe")
        remote = str(self.require(params, "remote"))
        filename = str(self.require(params, "filename"))
        public = self.as_bool(params.get("public"))

        if ctx.preview is not None:
            # Preview: don't upload — write the streamed bytes to a local preview file so the
            # encode can be eyeballed (mirrors how `upload` skips uploading under --preview).
            local = ctx.out_path(filename)
            print(f"  Preview: not uploading; writing stream → {local}")
            return ["dd", f"of={local}", "bs=1m"], {"produces": {"url": ""}}

        dest = _dest(remote, filename)
        url = public_url(remote, filename) if public else dest
        print(f"  Streaming upload → {dest}{' (public)' if public else ''}")
        if public:
            print(f"  Public URL: {url}")
        return ["rclone", "rcat", dest, *_acl_args(remote, public)], {"produces": {"url": url}}

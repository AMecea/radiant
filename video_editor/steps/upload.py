"""upload step — rclone copy an artifact to a remote, optionally public-read.

Outputs:
  url : public URL (when public:true), else the remote destination
"""

import sys
from pathlib import Path

from ..media import rclone_copy
from .base import Step, StepContext


class UploadStep(Step):
    action = "upload"
    produces = ("url",)

    def run(self, params: dict, ctx: StepContext) -> dict:
        file = Path(self.require(params, "file"))
        remote = str(self.require(params, "remote"))
        public = self.as_bool(params.get("public"))

        if ctx.preview is not None:
            print(f"  Preview mode: skipping upload of {file.name} → {remote}")
            return {"url": ""}

        if not ctx.dry_run and not file.exists():
            sys.exit(f"Error: file to upload not found: {file}")

        print(f"  Uploading {file} → {remote}{' (public)' if public else ''}")
        url = rclone_copy(file, remote, public=public, dry_run=ctx.dry_run)
        return {"url": url or remote}

"""youtube step — upload a video file to YouTube with a title and description.

Uses the YouTube Data API v3 (resumable upload) and OAuth user credentials. On
first run it opens a browser to authorise; the resulting token is cached so later
runs are non-interactive. As with ``upload``, the actual upload is skipped under
``--dry-run`` and ``--preview``.
"""

import sys
from pathlib import Path

from .base import Output, Param, Step, StepContext

# YouTube Data API upload scope.
_SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]


def _credentials(client_secrets: Path, token: Path):
    """Load cached OAuth credentials, refreshing or running the consent flow as needed."""
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError:
        sys.exit(
            "Error: youtube upload needs google-api-python-client and google-auth-oauthlib.\n"
            "  Install with: uv add google-api-python-client google-auth-oauthlib"
        )

    creds = None
    if token.exists():
        creds = Credentials.from_authorized_user_file(str(token), _SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not client_secrets.exists():
                sys.exit(
                    f"Error: OAuth client secrets not found: {client_secrets}\n"
                    "  Create an OAuth 'Desktop app' client in Google Cloud Console "
                    "(YouTube Data API v3 enabled) and download the JSON."
                )
            flow = InstalledAppFlow.from_client_secrets_file(str(client_secrets), _SCOPES)
            creds = flow.run_local_server(port=0)
        token.write_text(creds.to_json())

    return creds


class YouTubeUploadStep(Step):
    action = "youtube"
    summary = "Upload a local video to YouTube (Data API v3, OAuth user creds)."
    params = (
        Param("file", "Video file to upload.", type="path", required=True),
        Param("title", "Video title.", required=True),
        Param("description", "Video description.", default=""),
        Param("tags", "List of tags (or a comma-separated string).", type="list", default=[]),
        Param("category_id", "YouTube category id (22 = People & Blogs).", default="22"),
        Param("privacy_status", "Visibility of the uploaded video.",
              type="enum", choices=("private", "unlisted", "public"), default="private"),
        Param("client_secrets", "OAuth client-secrets JSON (a 'Desktop app' client).",
              type="path", default="client_secrets.json"),
        Param("token", "Cached-credentials file.",
              type="path", default="<workdir>/youtube_token.json"),
    )
    outputs = (
        Output("video_id", "The new video's id."),
        Output("url", "https://youtu.be/<video_id>"),
    )

    def run(self, params: dict, ctx: StepContext) -> dict:
        file = Path(self.require(params, "file"))
        title = str(self.require(params, "title"))
        description = str(params.get("description") or "")
        tags = params.get("tags") or []
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",") if t.strip()]
        category_id = str(params.get("category_id") or "22")
        privacy_status = str(params.get("privacy_status") or "private")
        client_secrets = Path(params.get("client_secrets") or "client_secrets.json")
        token = Path(params.get("token") or ctx.workdir / "youtube_token.json")

        if ctx.preview is not None:
            print(f"  Preview mode: skipping YouTube upload of {file.name}")
            return {"video_id": "", "url": ""}

        if ctx.dry_run:
            print(f"  [dry-run] would upload {file} to YouTube")
            print(f"            title={title!r} privacy={privacy_status} category={category_id}")
            return {"video_id": "", "url": ""}

        if not file.exists():
            sys.exit(f"Error: file to upload not found: {file}")

        try:
            from googleapiclient.discovery import build
            from googleapiclient.http import MediaFileUpload
        except ImportError:
            sys.exit(
                "Error: youtube upload needs google-api-python-client and google-auth-oauthlib.\n"
                "  Install with: uv add google-api-python-client google-auth-oauthlib"
            )

        creds = _credentials(client_secrets, token)
        youtube = build("youtube", "v3", credentials=creds)

        body = {
            "snippet": {
                "title": title,
                "description": description,
                "tags": tags,
                "categoryId": category_id,
            },
            "status": {"privacyStatus": privacy_status},
        }

        print(f"  Uploading {file} → YouTube (title={title!r}, privacy={privacy_status})")
        media = MediaFileUpload(str(file), chunksize=-1, resumable=True)
        request = youtube.videos().insert(part="snippet,status", body=body, media_body=media)

        response = None
        while response is None:
            status, response = request.next_chunk()
            if status:
                print(f"  Upload progress: {int(status.progress() * 100)}%")

        video_id = response["id"]
        url = f"https://youtu.be/{video_id}"
        print(f"  Uploaded: {url}")
        return {"video_id": video_id, "url": url}

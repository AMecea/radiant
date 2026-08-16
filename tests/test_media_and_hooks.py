"""Media plumbing helpers and the plan's shell hooks."""

from pathlib import Path

import pytest

from radiant import hooks, media


class TestIsBraw:
    @pytest.mark.parametrize("name,expected", [
        ("A001.braw", True), ("A001.BRAW", True),
        ("master.mp4", False), ("noext", False),
    ])
    def test_detects_the_container_by_suffix(self, name, expected):
        assert media.is_braw(Path("/clips") / name) is expected


class TestPublicUrl:
    @pytest.mark.parametrize("remote,filename,expected", [
        ("gs:bucket", "a.mp4", "https://storage.googleapis.com/bucket/a.mp4"),
        ("gs:bucket/video/2026-08-16/", "a.mp4",
         "https://storage.googleapis.com/bucket/video/2026-08-16/a.mp4"),
        ("gs:bucket/video", "a.mp4", "https://storage.googleapis.com/bucket/video/a.mp4"),
        ("s3:bucket/reels/", "r.mp4", "https://bucket.s3.amazonaws.com/reels/r.mp4"),
        ("S3:bucket", "r.mp4", "https://bucket.s3.amazonaws.com/r.mp4"),
    ])
    def test_builds_the_browser_url_for_a_remote(self, remote, filename, expected):
        assert media.public_url(remote, filename) == expected


class TestVideoCodecArgs:
    def test_hardware_encode_uses_videotoolbox_at_a_fixed_bitrate(self):
        assert media.video_codec_args(True, 18, "slow", "8M") == [
            "-c:v", "h264_videotoolbox", "-b:v", "8M", "-allow_sw", "1", "-color_range", "tv",
        ]

    def test_software_encode_uses_x264_with_crf(self):
        assert media.video_codec_args(False, 18, "slow", "8M") == [
            "-c:v", "libx264", "-preset", "slow", "-crf", "18",
        ]


def test_braw_fps_reads_the_rate_out_of_the_format_args():
    args = ["-f", "rawvideo", "-pixel_format", "rgba", "-s", "4608x2592", "-r", "23.976024", "-i", "pipe:0"]
    assert media.braw_fps(args) == pytest.approx(23.976024)


class TestRcloneCopy:
    def test_public_gs_upload_sets_the_acl_and_returns_the_url(self, tmp_path, capsys):
        url = media.rclone_copy(tmp_path / "a.mp4", "gs:bucket/video/", public=True, dry_run=True)

        assert url == "https://storage.googleapis.com/bucket/video/a.mp4"
        assert "--gcs-object-acl publicRead" in capsys.readouterr().out

    def test_public_s3_upload_sets_the_s3_acl(self, tmp_path, capsys):
        media.rclone_copy(tmp_path / "a.mp4", "s3:bucket", public=True, dry_run=True)
        assert "--s3-acl public-read" in capsys.readouterr().out

    def test_a_private_upload_reports_no_url(self, tmp_path):
        assert media.rclone_copy(tmp_path / "a.mp4", "gs:bucket", dry_run=True) is None

    def test_public_is_refused_for_a_remote_with_no_acl_story(self, tmp_path):
        with pytest.raises(SystemExit, match="public upload is not supported"):
            media.rclone_copy(tmp_path / "a.mp4", "dropbox:x", public=True, dry_run=True)


class TestHooks:
    def test_placeholders_are_filled_in(self):
        template = "{name}/{step}/{code}/{url}/{message}/{pid}"
        ctx = {"name": "job", "step": "sync", "code": 1, "url": "http://x", "message": "m", "pid": 42}
        assert hooks._format(template, ctx) == "job/sync/1/http://x/m/42"

    def test_absent_context_values_become_empty(self):
        assert hooks._format("[{name}][{url}]", {"name": "job"}) == "[job][]"

    def test_a_stray_brace_in_the_users_command_is_left_alone(self):
        template = "awk '{print $1}' file"
        assert hooks._format(template, {"name": "job"}) == template

    def test_an_unset_hook_is_a_no_op(self, capsys):
        hooks.run_hook({}, "on_start", {})
        hooks.run_hook({"on_start": ""}, "on_start", {})
        assert capsys.readouterr().out == ""

    def test_it_runs_the_command(self, tmp_path):
        marker = tmp_path / "hook.txt"
        hooks.run_hook({"on_success": f"echo {{name}} > {marker}"}, "on_success", {"name": "job"})
        assert marker.read_text() == "job\n"

    def test_dry_run_only_prints(self, tmp_path, capsys):
        marker = tmp_path / "hook.txt"
        hooks.run_hook({"on_success": f"touch {marker}"}, "on_success", {}, dry_run=True)

        assert not marker.exists()
        assert f"[hook:on_success] $ touch {marker}" in capsys.readouterr().out

    def test_a_failing_hook_warns_but_never_masks_the_run(self, capsys):
        hooks.run_hook({"on_success": "exit 7"}, "on_success", {})
        assert "warning: exited 7 (ignored)" in capsys.readouterr().out

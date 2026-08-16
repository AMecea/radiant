"""Shared fixtures.

Tests exercise the real runner end to end rather than mocking it — the `shell`
action makes that cheap (a plan of `echo`/`cat` commands runs in milliseconds and
still goes through resolution, state, freshness and hooks exactly as a real
encode would). Nothing here needs ffmpeg, rclone or the network.
"""

from pathlib import Path

import pytest
import yaml

from radiant.plan import Plan
from radiant.steps import REGISTRY
from radiant.steps.base import Output, Param, Step


@pytest.fixture
def workdir(tmp_path: Path) -> Path:
    return tmp_path / "wd"


@pytest.fixture
def write_plan(tmp_path: Path, workdir: Path):
    """Write a plan dict to YAML (workdir pinned inside tmp_path) and return its path."""

    def _write(doc: dict, filename: str = "plan.yaml") -> Path:
        doc = dict(doc)
        doc.setdefault("name", "testplan")
        doc.setdefault("workdir", str(workdir))
        path = tmp_path / filename
        path.write_text(yaml.safe_dump(doc, sort_keys=False))
        return path

    return _write


@pytest.fixture
def load_plan(write_plan):
    """Write a plan dict and load it in one go."""

    def _load(doc: dict, **kwargs) -> Plan:
        return Plan.load(write_plan(doc), **kwargs)

    return _load


@pytest.fixture
def echo_plan(write_plan):
    """A two-step shell plan: `one` writes a file, `two` consumes it by reference."""
    return write_plan({
        "vars": {"greeting": "hello", "who": "world"},
        "steps": [
            {"id": "one", "action": "shell",
             "with": {"cmd": "echo ${vars.greeting} ${vars.who} > {output}", "output": "a.txt"}},
            {"id": "two", "action": "shell", "needs": ["one"],
             "with": {"cmd": "cat ${steps.one.file} > {output}", "output": "b.txt"}},
        ],
    })


class ProbeStep(Step):
    """A test-only analysis step: cheap, deterministic, and unaffected by --preview
    (like `sync`), so it exercises the preview-persistence path without librosa."""

    action = "probe"
    summary = "test-only analysis step"
    preview_affects_output = False
    params = (Param("value", "Value to report back.", required=True),)
    outputs = (Output("value", "The value, echoed."),)

    def run(self, params: dict, ctx) -> dict:
        return {"value": params["value"]}


@pytest.fixture
def probe_action(monkeypatch):
    """Register the `probe` action for the duration of one test."""
    monkeypatch.setitem(REGISTRY, ProbeStep.action, ProbeStep)
    return ProbeStep.action

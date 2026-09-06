# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0
"""Loads an adk-python contributing sample and pins its model.

Each case under `agents/py/<case>/agent.py` is a three-line shim that imports
the *real* sample out of the vendored adk-python checkout. The samples
themselves are never edited, so the parity run measures the upstream sample and
`git status` in the checkout stays clean.

The model is pinned because the two runtimes ship different defaults, and a
sample that omits `model=` would otherwise compare two different models and
blame the framework for the difference.
"""

from __future__ import annotations

import importlib
import os
from pathlib import Path
import sys
from typing import Any

from google.adk.apps.app import App

_HERE = Path(__file__).resolve().parent
_ADK_PYTHON = _HERE.parent.parent / "adk-python"
_SAMPLES = _ADK_PYTHON / "contributing" / "samples"

PARITY_MODEL = os.environ.get("ADK_PARITY_MODEL", "gemini-2.5-flash")


def _pin_model(node: Any, seen: set[int]) -> None:
  """Recursively rewrites string models to the pinned one.

  A non-string `model` is a configured BaseLlm (LiteLlm, Anthropic, ...). Those
  cases are about the model plugin itself, so they are left alone.
  """
  if node is None or id(node) in seen:
    return
  seen.add(id(node))

  model = getattr(node, "model", None)
  if isinstance(model, str) and model:
    try:
      node.model = PARITY_MODEL
    except (AttributeError, ValueError):
      pass  # frozen or validated field; report will show the original model
  elif model == "" or (hasattr(node, "model") and model is None):
    try:
      node.model = PARITY_MODEL
    except (AttributeError, ValueError):
      pass

  for attr in ("sub_agents", "agents", "nodes", "tools"):
    for child in getattr(node, attr, None) or []:
      # AgentTool wraps an agent; workflow nodes wrap agents too.
      _pin_model(child, seen)
      _pin_model(getattr(child, "agent", None), seen)

  _pin_model(getattr(node, "root_agent", None), seen)


def load_sample(rel_path: str, *, pin_model: bool = True) -> Any:
  """Imports `contributing/samples/<rel_path>` and returns its root agent/app.

  `rel_path` is e.g. "core/hello_world". The sample's parent directory goes on
  `sys.path` and the sample is imported as a package, which is what ADK's own
  AgentLoader does — samples rely on it for their relative imports.
  """
  sample_dir = _SAMPLES / rel_path
  if not sample_dir.is_dir():
    raise FileNotFoundError(f"No such sample: {sample_dir}")

  parent = str(sample_dir.parent)
  if parent not in sys.path:
    sys.path.insert(0, parent)

  # Most samples put the root agent in `<sample>/agent.py`, but a few keep it
  # in the package `__init__` instead (plugins/plugin_basic re-exports it from
  # main.py). ADK's own AgentLoader accepts both shapes; so does this.
  module_name = sample_dir.name
  if (sample_dir / "agent.py").is_file():
    module_name = f"{sample_dir.name}.agent"
  module = importlib.import_module(module_name)

  # `app` first, then `root_agent` — the same precedence as ADK's own
  # AgentLoader ("Check for 'app' first, then 'root_agent'",
  # cli/utils/agent_loader.py). It matters: a sample that exports both would
  # otherwise run as a bare agent here while the TS CLI — which also prefers
  # `app` — ran the full App, and every plugin, compaction and resumability
  # setting attached to the App would show up as a phantom parity difference.
  root = getattr(module, "app", None)
  if not isinstance(root, App):
    root = None
  if root is None:
    root = getattr(module, "root_agent", None)
  if root is None:
    raise AttributeError(f"{rel_path} exports neither root_agent nor app")

  if pin_model:
    _pin_model(root, set())

  return root

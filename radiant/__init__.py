"""radiant — a YAML-driven video/audio processing pipeline.

A *plan* (YAML) declares an ordered list of *steps*. Each step writes output
artifacts into a persisted workdir; later steps consume earlier steps' outputs by
reference (``${steps.<id>.<output>}``). Steps can be run a slice at a time
(``--step 1-2`` then ``--step 3-``) and the run is resumable via the workdir state.
"""

__version__ = "0.1.0"

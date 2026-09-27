# Real-world ScratchJr fixtures

`public-animal-race-shape.json` models the field combinations seen in real ScratchJr projects rather than the editor's own minimal export shape.

It is adapted from public ScratchJr file-format documentation (including the documented Animal Race/Horse metadata fields such as `homeflip`, `homescale`, `defaultScale`, `speed`, coordinates, sounds and nested scripts) and is exercised by an actual ZIP/`.sjr` archive round-trip test.

The fixture is intentionally small and stores only metadata authored for this test; no third-party artwork or audio is copied into this repository. Placeholder SVG/audio bytes are generated inside the test.

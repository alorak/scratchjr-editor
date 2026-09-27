# Real-world ScratchJr fixtures

`public-animal-race-shape.json` models the field combinations seen in real ScratchJr projects rather than the editor's own minimal export shape.

It is adapted from public ScratchJr file-format documentation (including the documented Animal Race/Horse metadata fields such as `homeflip`, `homescale`, `defaultScale`, `speed`, coordinates, sounds and nested scripts) and is exercised by an actual ZIP/`.sjr` archive round-trip test.

The fixture is intentionally small and stores only metadata authored for this test; no third-party artwork or audio is copied into this repository. Placeholder SVG/audio bytes are generated inside the test.

Public references used to shape the fixture:
- ScratchJr file-format documentation in the public `wangzongjun/ScratchJr` repository.
- Public `.sjr` project collection in `KidsHacking/ScratchJr/Projects`.

These references are used only to mirror realistic metadata/layout conventions; the committed fixture content and placeholder media are purpose-built for this test suite.

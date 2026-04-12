# Phase 1, Subphase 1: Data Structures

This document is a structural placeholder in the documentation hierarchy. The data structures for the syntactic parsing phase are fully described in Part 1 of the phase document:

**[phase1-syntactic-parsing.md — Part 1: Data Structures](../phase1-syntactic-parsing.md)**

That document covers:
- Source location and span types (`SourceLocation`, `Span`)
- Token kinds (`TokenKind` enum) and the `Token` interface
- Keyword lookup table
- All AST node types: `StoredDefinition`, `ClassDefinition`, `ShortClassDefinition`, elements, modifications, annotations, equation sections, algorithm sections, expressions, component references, and external declarations

The data structures are defined there rather than here because the phase document was written first and is already comprehensive. Duplicating that content here would create a maintenance burden. If focused discussion of a particular data structure is needed, it should be added as a note in this document with a pointer to the relevant section in the phase document.

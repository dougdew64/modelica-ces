# Phase 1, Subphase 2: Lexer

This document describes the implementation of the Modelica lexer (tokenizer). The lexer converts raw source text into a flat sequence of tokens for consumption by the parser.

Scope:
- Lexer class structure and state
- Character scanning and token recognition
- Handling of Modelica-specific lexing rules (nested comments, quoted identifiers, numeric literals, keywords vs identifiers)

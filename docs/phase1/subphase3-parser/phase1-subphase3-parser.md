# Phase 1, Subphase 3: Parser

This document describes the implementation of the Modelica parser. The parser consumes the token stream produced by the lexer and builds an Abstract Syntax Tree (AST).

Scope:
- Parser class structure and token consumption model
- Recursive descent parsing of Modelica grammar rules
- Pratt (precedence climbing) parser for expressions
- Error reporting and recovery

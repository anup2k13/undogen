"""Journaled, undoable API calls for Python agents, driven by plans compiled by ``undogen compile``."""

from .client import (
    Bundle,
    ConflictError,
    DependencyError,
    FileJournalStore,
    IrreversibleOperationError,
    MemoryJournalStore,
    OutgoingRequest,
    ReplayBlockedError,
    UndoableClient,
    UndoError,
    UndogenError,
)
from .tools import ToolDefinition, describe_entry, tool_definitions

__all__ = [
    "Bundle",
    "ConflictError",
    "DependencyError",
    "FileJournalStore",
    "IrreversibleOperationError",
    "MemoryJournalStore",
    "OutgoingRequest",
    "ReplayBlockedError",
    "ToolDefinition",
    "UndoableClient",
    "UndoError",
    "UndogenError",
    "describe_entry",
    "tool_definitions",
]
__version__ = "0.1.0"

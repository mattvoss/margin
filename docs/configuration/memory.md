# Memory

Workspace memory is optional and disabled unless enabled on the server. When it
is enabled, the Memory settings panel can index Markdown files, extract durable
writing context, and store embeddings for later recall.

## Source references

Memories created from Markdown files retain a workspace-relative source path.
When the extracted memory text can be located in the source document, Margin
also stores its one-based line range, character offsets, nearest Markdown
heading, and a SHA-256 hash of the indexed file. The Memory panel displays this
information and can open the source file.

The location is best-effort: an extraction may have no exact matching passage,
in which case the path remains available but the line and offset fields are
empty. If the source file changes or is removed, the panel marks the reference
as **Source changed** rather than presenting the old line range as current.

Existing memories that only have the legacy `file:<path>` source identifier
continue to display their source path; they acquire precise metadata the next
time their file is indexed.

## Related `@file` mentions

Each memory may have user-managed related Markdown files. These are stored
separately from the remembered text, so adding or removing a mention does not
re-embed the memory. In Settings → Memory, use **+ Add file** to add a related
file, or select an existing `@file` chip to remove it.

Only existing, workspace-relative Markdown files can be added. Hidden files,
`prompts/`, `outputs/`, traversal paths, and files in another workspace are
rejected by the server. Mention text is displayed as inert data and is never
treated as an instruction.

## Re-indexing and privacy

Indexing processes Markdown files sequentially to bound provider load. A file's
old generated memories are archived only after extraction and embedding for
that file succeed; provider failures therefore do not erase the previous
memories. User-managed related mentions are preserved when a file is
re-indexed.

Indexing sends the selected workspace's Markdown content to the configured LLM
and embedding providers. Memories, source paths, and mentions are scoped to
the active workspace. Embedding vectors and provider credentials are not
returned by the memory API.

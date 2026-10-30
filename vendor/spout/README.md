# SpoutLibrary.dll

Spout's C-compatible library, used by `server/outputs.mjs` to publish the picture as a Spout sender on Windows.

- Source: [leadedge/Spout2](https://github.com/leadedge/Spout2), tag `2.007.018`, file `SPOUTSDK/SpoutLibrary/Binaries/SpoutLibrary.dll` (64-bit)
- SHA-256: `a5f848e93b5b39d7f748f0333bf0faafbfffcc31fa0eb4522afc17b73cbd3f67`
- License: BSD 2-Clause, see `LICENSE`
- Needs the Microsoft Visual C++ Redistributable (2015–2022, x64), which most Windows machines already have.

## How the vtable slots were checked

`GetSpout()` returns a `SPOUTLIBRARY` object, and its methods are called through the vtable. The slot numbers in `server/outputs.mjs` were read from the DLL itself:

1. `GetSpout` stores the address of the implementation's vtable in the new object (`lea rax, [0x1800361d0]`).
2. Each of those 170 slots is a small thunk that jumps to the exported `Spout`/`spoutGL` method it wraps, which gives this mapping:

| Slot | Thunk jumps to |
|---:|---|
| 0 | `Spout::SetSenderName` |
| 2 | `Spout::ReleaseSender` |
| 5 | `Spout::SendImage` |
| 151 | `spoutGL::CreateOpenGL` |
| 152 | `spoutGL::CloseOpenGL` |
| 169 | `Release` (deletes the object) |

The check was a static reading of the DLL; it has not been run on Windows. If you replace the DLL with another version, repeat the check, because the slot numbers can change.

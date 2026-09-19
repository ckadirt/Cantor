# Cantor TODO

## Audio

- [ ] Add progressive song playback during encrypted node-to-app transfers.
  Start playing an existing Ogg/Opus delivery artifact after an initial buffer
  while the remaining chunks continue downloading. Reuse the resumable transfer
  protocol, preserve final length and SHA-256 verification, and keep the completed
  artifact compatible with the existing cache and pin behavior. Define buffering,
  underrun, reconnect, and buffered-range seeking behavior. This item does not
  include playback while the model is still generating audio; track that as
  separate future work if needed.

/**
 * A fixed, WebAuthn-shaped ES256 test vector (round 9 lane S9). Made once
 * with Node's own crypto, exactly as a platform authenticator answers
 * `navigator.credentials.get()`: authenticator data (SHA-256 of the
 * relying-party id, flags user present + user verified, sign count 7), the
 * browser's client data JSON (`webauthn.get`, the challenge, the origin), and
 * a DER ECDSA P-256 signature over `authenticatorData ‖ SHA-256(clientDataJSON)`.
 *
 * The challenge is the SHA-256 of `PAYLOAD`, which is a sign-off record's
 * hash preimage (genesis, entry 1, merge approved), so the same vector checks
 * the verifier and the chain. The registration half is a `create()` answer
 * for the same key (attestation "none", COSE ES256 key in the authenticator
 * data). Nothing here is a secret: the private key was thrown away.
 *
 * oss-clean: legacy-host-id-file. The relying party, origin and provider id
 * are inside the signed bytes, so they stay as they were signed.
 */
export const VECTOR = {
  rpId: "app.polygnotos.test",
  origin: "https://app.polygnotos.test",
  spki: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEnDxfoXBjbyemDpPOK-1uvYLjTuEDoXHHQ4oOrSDgo0zSV-dMptUX33fKB3jMwYwD8aGNAdQ_QcNlQfszDFFo6w",
  payload:
    'pzsig/v10000000000000000000000000000000000000000000000000000000000000000{"actor_user_id":"00000000-0000-0000-0000-000000000a01","base_model_id":"site-9001","payload":{"author":{"kind":"person","provider":"polygnotos","subject":"00000000-0000-0000-0000-000000000a01"},"discipline":"mechanical"},"project_id":"00000000-0000-0000-0000-000000000b01","record_kind":"merge_approved","seq":1,"subject_id":"00000000-0000-0000-0000-000000000c01"}',
  recordHash: "699ec0b2939da03f9ac5764516cf5a445ccf975c6616e89dd29b92b13b0a8627",
  authenticatorData: "Gfcik2zmdmouQRsyjVtFe4Dl-u4oYhhCf-9nq3IQ83MFAAAABw",
  clientDataJSON:
    "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiYVo3QXNwT2RvRC1heFhaRkZzOWFSRnpQbDF4bUZ1aWQwcHVTc1RzS2hpYyIsIm9yaWdpbiI6Imh0dHBzOi8vYXBwLnBvbHlnbm90b3MudGVzdCIsImNyb3NzT3JpZ2luIjpmYWxzZX0",
  signature: "MEUCIQCLj-BcAFuolxXs7ieuRlskUOc2bghOu_jNFczmEpwYtgIgCyHaylRqNH7weQ5MO9i-dhlVpUtiHpiUjZPXgcQj0No",
  credentialId: "czktdGVzdC1jcmVkZW50aWFsLTAwMDE",
  regAuthenticatorData:
    "Gfcik2zmdmouQRsyjVtFe4Dl-u4oYhhCf-9nq3IQ83NFAAAAAAAAAAAAAAAAAAAAAAAAAAAAF3M5LXRlc3QtY3JlZGVudGlhbC0wMDAxpQECAyYgASFYIJw8X6FwY28npg6Tzivtbr2C407hA6Fxx0OKDq0g4KNMIlgg0lfnTKbVF993ygd4zMGMA_GhjQHUP0HDZUH7MwxRaOs",
  regClientDataJSON:
    "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdsbyIsIm9yaWdpbiI6Imh0dHBzOi8vYXBwLnBvbHlnbm90b3MudGVzdCIsImNyb3NzT3JpZ2luIjpmYWxzZX0",
  regChallenge: "WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo",
  signer: "00000000-0000-0000-0000-000000000a01",
} as const;

/** The sign-off record whose hash preimage is `VECTOR.payload`. */
export const VECTOR_RECORD = {
  seq: 1,
  projectId: "00000000-0000-0000-0000-000000000b01",
  baseModelId: "site-9001",
  recordKind: "merge_approved",
  subjectId: "00000000-0000-0000-0000-000000000c01",
  actorUserId: VECTOR.signer,
  payload: { author: { kind: "person", provider: "polygnotos", subject: VECTOR.signer }, discipline: "mechanical" },
  prevHash: "0".repeat(64),
  recordHash: VECTOR.recordHash,
} as const;

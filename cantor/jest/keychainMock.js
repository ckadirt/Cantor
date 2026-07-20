/* global jest */

const SECURITY_LEVEL = {
  SECURE_SOFTWARE: 0,
  SECURE_HARDWARE: 1,
  ANY: 2,
};

const STORAGE_TYPE = {
  AES_GCM_NO_AUTH: 'KeystoreAESGCM_NoAuth',
  AES_GCM: 'KeystoreAESGCM',
  RSA: 'KeystoreRSAECB',
};

module.exports = {
  SECURITY_LEVEL,
  STORAGE_TYPE,
  getGenericPassword: jest.fn(async () => false),
  setGenericPassword: jest.fn(async () => ({
    service: 'mock',
    storage: STORAGE_TYPE.AES_GCM_NO_AUTH,
  })),
};

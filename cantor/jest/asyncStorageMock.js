/* global jest */

function storage() {
  const values = new Map();
  return {
    getItem: jest.fn(async key => values.get(key) ?? null),
    setItem: jest.fn(async (key, value) => {
      values.set(key, value);
    }),
    removeItem: jest.fn(async key => {
      values.delete(key);
    }),
    clear: jest.fn(async () => {
      values.clear();
    }),
  };
}

// One database per name, as the real `createAsyncStorage` gives.
const databases = new Map();

module.exports = {
  __esModule: true,
  default: storage(),
  createAsyncStorage: jest.fn(name => {
    if (!databases.has(name)) databases.set(name, storage());
    return databases.get(name);
  }),
};

// op-sqlite is a native (JSI) module. Screens under test open the phone
// database through `device/database.ts`; here that open fails, so the device
// library reports itself unavailable and the field shows node songs only.
// Tests of the database itself bind the port to Node's SQLite instead
// (`jest/nodeSqlite.ts`).
module.exports = {
  open: () => {
    throw new Error('op-sqlite is not available in tests.');
  },
};

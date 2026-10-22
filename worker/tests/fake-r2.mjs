// In-memory stand-in for the DOCUMENTS R2 bucket: put/get/list/delete.
export function fakeR2({ failDelete = false } = {}) {
  const store = new Map();
  return {
    store,
    async put(key, value) {
      const body = typeof value === 'string' ? value : new TextDecoder().decode(value);
      store.set(key, { body, uploaded: new Date() });
      return { key };
    },
    async get(key) {
      const item = store.get(key);
      if (!item) return null;
      return { body: item.body, json: async () => JSON.parse(item.body), text: async () => item.body };
    },
    async list({ prefix = '' } = {}) {
      return { objects: [...store.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, item]) => ({ key, uploaded: item.uploaded })), truncated: false };
    },
    async delete(key) {
      if (failDelete) throw Error('R2 unavailable');
      store.delete(key);
    }
  };
}

export const crmGoldenTest: string = `
import request from 'supertest';
let app: any;
let appLoadError: unknown;
const load = async (path: string) => { try { return await import(path); } catch (error) { appLoadError = error; return undefined; } };
for (const path of ['../app.js', '../server.js', '../index.js']) { const mod = await load(path); app = mod?.app ?? mod?.default; if (app) break; }
if (!app) throw appLoadError ?? new Error('Unable to load app module');
let seq = 0;
const tag = (prefix: string) => prefix + '-' + ++seq;
const field = (obj: any, ...names: string[]) => names.reduce((value, name) => value ?? obj?.[name], undefined);
const entity = (body: any) => body.contact ?? body.deal ?? body.note ?? body.data?.contact ?? body.data?.deal ?? body.data?.note ?? body.data ?? body;
const rows = (body: any) => Array.isArray(body) ? body : body.contacts ?? body.deals ?? body.notes ?? body.results ?? body.items ?? body.data?.contacts ?? body.data?.results ?? body.data?.items ?? body.data ?? [];
const total = (body: any) => body.total ?? body.count ?? body.data?.total ?? body.data?.count ?? rows(body).length;
const created = (status: number) => expect([200, 201]).toContain(status);
const route = (path: string) => [path, '/api' + path];
const call = async (paths: string[], send: (path: string) => Promise<any>) => { let response: any; for (const path of paths) { response = await send(path); if (response.status !== 404) return response; } return response; };
const post = (path: string, body: any) => call(route(path), (next) => request(app).post(next).send(body));
const get = (path: string) => call(route(path), (next) => request(app).get(next));
const patch = (path: string, body: any) => call(route(path), (next) => request(app).patch(next).send(body));
const put = (path: string, body: any) => call(route(path), (next) => request(app).put(next).send(body));
const del = (path: string) => call(route(path), (next) => request(app).delete(next));
const createContact = async (overrides: Record<string, unknown> = {}) => {
  const token = tag('contact');
  const payload = { firstName: 'Test', lastName: token, email: token + '@example.com', ...overrides };
  const response = await post('/contacts', payload), contact = entity(response.body);
  created(response.status);
  expect(field(contact, 'firstName', 'first_name')).toBe(payload.firstName); expect(field(contact, 'lastName', 'last_name')).toBe(payload.lastName);
  expect(field(contact, 'email')).toBe(payload.email); expect(field(contact, 'createdAt', 'created_at')).toEqual(expect.any(String));
  return contact;
};
const createDeal = async (contactId: any, overrides: Record<string, unknown> = {}) => {
  const statuses = 'status' in overrides ? [String(overrides.status)] : ['open', 'pending', 'active'];
  let response: any, payload: any;
  for (const status of statuses) {
    payload = { contactId, title: 'Deal ' + tag('deal'), value: 5000, status, ...overrides };
    response = await post('/deals', payload);
    if ([200, 201].includes(response.status)) {
      const deal = entity(response.body);
      expect(field(deal, 'title')).toBe(payload.title); expect(field(deal, 'value')).toBe(payload.value);
      expect(field(deal, 'status')).toBe(payload.status); expect(field(deal, 'contactId', 'contact_id')).toBe(payload.contactId);
      return deal;
    }
  }
  created(response.status);
  return entity(response.body);
};
const createNote = async (overrides: Record<string, unknown> = {}) => {
  const payload = { content: 'Note ' + tag('note'), ...overrides };
  const response = await post('/notes', payload), note = entity(response.body);
  created(response.status); expect(field(note, 'content')).toBe(payload.content);
  return note;
};
const searchContacts = async (term: string, extra = '') => {
  const enc = encodeURIComponent(term), paths = ['/contacts/search?q=' + enc + extra, '/contacts?search=' + enc + extra, '/contacts?q=' + enc + extra, '/search?query=' + enc + extra, '/search?q=' + enc + extra].flatMap(route);
  let best: any;
  for (const path of paths) {
    const response = await request(app).get(path);
    if (response.status !== 200) continue;
    const items = rows(response.body);
    if (!best || (items.length > 0 && items.length < (rows(best.body).length || Infinity))) best = response;
    if (items.length > 0 && items.some((item: any) => JSON.stringify(item).toLowerCase().includes(term.toLowerCase()))) return response;
  }
  return best ?? (await request(app).get(paths[0]));
};
const updateContact = async (contact: any, email: string) => {
  const id = field(contact, 'id'), patchResponse = await patch('/contacts/' + id, { email });
  if ([200, 204].includes(patchResponse.status)) return patchResponse;
  return put('/contacts/' + id, { firstName: field(contact, 'firstName', 'first_name'), lastName: field(contact, 'lastName', 'last_name'), email, phone: field(contact, 'phone') ?? undefined });
};
describe('crm golden: relationship graph', () => {
  test('persists contact, deal, and linked notes', async () => {
    const contact = await createContact({ firstName: 'Graph' }), contactId = field(contact, 'id');
    const deal = await createDeal(contactId, { title: 'Expansion' }), dealId = field(deal, 'id');
    const contactNote = await createNote({ contactId, content: 'Contact note' });
    const dealNote = await createNote({ dealId, content: 'Deal note' });
    const sharedNote = await createNote({ contactId, dealId, content: 'Shared note' });
    expect(field(entity((await get('/contacts/' + contactId)).body), 'id')).toBe(contactId);
    expect(field(entity((await get('/deals/' + dealId)).body), 'contactId', 'contact_id')).toBe(contactId);
    expect(field(entity((await get('/notes/' + field(contactNote, 'id'))).body), 'contactId', 'contact_id')).toBe(contactId);
    expect(field(entity((await get('/notes/' + field(dealNote, 'id'))).body), 'dealId', 'deal_id')).toBe(dealId);
    const linked = entity((await get('/notes/' + field(sharedNote, 'id'))).body);
    expect(field(linked, 'contactId', 'contact_id')).toBe(contactId); expect(field(linked, 'dealId', 'deal_id')).toBe(dealId);
  });
});
describe('crm golden: update workflow', () => {
  test('keeps deal linkage after a contact email change', async () => {
    const contact = await createContact(), contactId = field(contact, 'id');
    const deal = await createDeal(contactId), nextEmail = tag('updated') + '@example.com';
    expect([200, 204]).toContain((await updateContact(contact, nextEmail)).status);
    expect(field(entity((await get('/contacts/' + contactId)).body), 'email')).toBe(nextEmail);
    expect(field(entity((await get('/deals/' + field(deal, 'id'))).body), 'contactId', 'contact_id')).toBe(contactId);
  });
});
describe('crm golden: search and pagination', () => {
  test('finds matching contacts by partial name and paginates results', async () => {
    const searchToken = tag('find'), pageToken = tag('page');
    const first = await createContact({ firstName: 'Alicia', lastName: 'Ally-' + searchToken });
    const second = await createContact({ firstName: 'Alina', lastName: 'Ally-' + searchToken });
    await createContact({ firstName: 'Boris', lastName: 'Beta-' + searchToken });
    for (let index = 0; index < 12; index += 1) await createContact({ firstName: 'Page' + index, lastName: 'Batch-' + pageToken });
    const filtered = await searchContacts('lly-' + searchToken);
    expect(filtered.status).toBe(200);
    const found = rows(filtered.body).filter((item: any) => String(field(item, 'lastName', 'last_name') ?? '').includes('Ally-' + searchToken));
    expect(found.map((item: any) => field(item, 'email')).sort()).toEqual([field(first, 'email'), field(second, 'email')].sort());
    const paged = await searchContacts('Batch-' + pageToken, '&limit=5');
    expect(paged.status).toBe(200);
    expect(rows(paged.body).filter((item: any) => String(field(item, 'lastName', 'last_name') ?? '').includes(pageToken))).toHaveLength(5);
    if (typeof paged.body.total === 'number' || typeof paged.body.data?.total === 'number') expect(total(paged.body)).toBe(12);
    if (typeof paged.body.count === 'number' || typeof paged.body.data?.count === 'number') expect([5, 12]).toContain(total(paged.body));
  });
});
describe('crm golden: validation boundaries', () => {
  test('rejects invalid contacts and deals for missing relationships', async () => {
    expect((await post('/contacts', { firstName: 'No', lastName: 'Email' })).status).toBe(400);
    expect((await post('/contacts', { firstName: 'Bad', lastName: 'Email', email: 'not-an-email' })).status).toBe(400);
    const deleted = await createContact({ firstName: 'Ghost' }), deletedId = field(deleted, 'id');
    expect([200, 204]).toContain((await del('/contacts/' + deletedId)).status);
    expect([400, 404, 409, 422]).toContain((await post('/deals', { contactId: deletedId, title: 'Should fail', value: 100, status: 'open' })).status);
  });
});
describe('crm golden: note flexibility', () => {
  test('allows notes with contact only, deal only, both, or neither', async () => {
    const contact = await createContact({ firstName: 'NoteFlex' }), contactId = field(contact, 'id');
    const deal = await createDeal(contactId, { title: 'Flexible note deal' });
    const notes = [await createNote({ contactId }), await createNote({ dealId: field(deal, 'id') }), await createNote({ contactId, dealId: field(deal, 'id') }), await createNote()];
    expect(notes.every((note: any) => Boolean(field(note, 'id')))).toBe(true);
  });
});
describe('crm golden: edge cases', () => {
  test('handles phone variants and returns 404 after delete', async () => {
    const withUndefined = await post('/contacts', { firstName: 'Phone', lastName: 'Undefined-' + tag('phone'), email: tag('undefined') + '@example.com', phone: undefined });
    const omitted = await post('/contacts', { firstName: 'Phone', lastName: 'Omitted-' + tag('phone'), email: tag('omitted') + '@example.com' });
    created(withUndefined.status); created(omitted.status);
    const contactId = field(entity(withUndefined.body), 'id');
    expect([200, 204]).toContain((await del('/contacts/' + contactId)).status);
    expect((await get('/contacts/' + contactId)).status).toBe(404);
  });
});
`;

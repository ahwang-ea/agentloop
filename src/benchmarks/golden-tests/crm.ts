export const crmGoldenTest: string = `
import request from 'supertest';
import app from '../app.js';

let seq = 0;
const tag = (prefix: string) => prefix + '-' + ++seq;
const entity = (body: any) => body.contact ?? body.deal ?? body.note ?? body.data?.contact ?? body.data?.deal ?? body.data?.note ?? body.data ?? body;
const rows = (body: any) => Array.isArray(body) ? body : body.contacts ?? body.deals ?? body.notes ?? body.results ?? body.items ?? body.data?.contacts ?? body.data?.results ?? body.data?.items ?? body.data ?? [];
const total = (body: any) => body.total ?? body.count ?? body.data?.total ?? body.data?.count ?? rows(body).length;
const created = (status: number) => expect([200, 201]).toContain(status);
const same = (item: any, expected: Record<string, unknown>) => expect(item).toEqual(expect.objectContaining(expected));

const createContact = async (overrides: Record<string, unknown> = {}) => {
  const token = tag('contact');
  const payload = { firstName: 'Test', lastName: token, email: token + '@example.com', ...overrides };
  const response = await request(app).post('/contacts').send(payload);
  const contact = entity(response.body);
  created(response.status);
  same(contact, { firstName: payload.firstName, lastName: payload.lastName, email: payload.email, createdAt: expect.any(String) });
  return contact;
};

const createDeal = async (contactId: any, overrides: Record<string, unknown> = {}) => {
  const statuses = 'status' in overrides ? [String(overrides.status)] : ['open', 'pending', 'active'];
  let response, payload;
  for (const status of statuses) {
    payload = { contactId, title: 'Deal ' + tag('deal'), value: 5000, status, ...overrides };
    response = await request(app).post('/deals').send(payload);
    if ([200, 201].includes(response.status)) {
      const deal = entity(response.body);
      same(deal, { title: payload.title, value: payload.value, status: payload.status, contactId: payload.contactId });
      return deal;
    }
  }
  created(response!.status);
  return entity(response!.body);
};

const createNote = async (overrides: Record<string, unknown> = {}) => {
  const payload = { content: 'Note ' + tag('note'), ...overrides };
  const response = await request(app).post('/notes').send(payload);
  const note = entity(response.body);
  created(response.status);
  same(note, { content: payload.content });
  return note;
};

const searchContacts = async (term: string, extra = '') => {
  const enc = encodeURIComponent(term);
  const paths = ['/contacts/search?q=' + enc + extra, '/contacts?search=' + enc + extra, '/contacts?q=' + enc + extra, '/search?query=' + enc + extra, '/search?q=' + enc + extra];
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
  const patch = await request(app).patch('/contacts/' + contact.id).send({ email });
  if ([200, 204].includes(patch.status)) return patch;
  return request(app).put('/contacts/' + contact.id).send({ firstName: contact.firstName, lastName: contact.lastName, email, phone: contact.phone ?? undefined });
};

describe('crm golden: relationship graph', () => {
  test('persists contact, deal, and linked notes', async () => {
    const contact = await createContact({ firstName: 'Graph' });
    const deal = await createDeal(contact.id, { title: 'Expansion' });
    const contactNote = await createNote({ contactId: contact.id, content: 'Contact note' });
    const dealNote = await createNote({ dealId: deal.id, content: 'Deal note' });
    const sharedNote = await createNote({ contactId: contact.id, dealId: deal.id, content: 'Shared note' });
    expect(entity((await request(app).get('/contacts/' + contact.id)).body).id).toBe(contact.id);
    expect(entity((await request(app).get('/deals/' + deal.id)).body).contactId).toBe(contact.id);
    expect(entity((await request(app).get('/notes/' + contactNote.id)).body).contactId).toBe(contact.id);
    expect(entity((await request(app).get('/notes/' + dealNote.id)).body).dealId).toBe(deal.id);
    const linked = entity((await request(app).get('/notes/' + sharedNote.id)).body);
    expect(linked.contactId).toBe(contact.id);
    expect(linked.dealId).toBe(deal.id);
  });
});

describe('crm golden: update workflow', () => {
  test('keeps deal linkage after a contact email change', async () => {
    const contact = await createContact();
    const deal = await createDeal(contact.id);
    const nextEmail = tag('updated') + '@example.com';
    expect([200, 204]).toContain((await updateContact(contact, nextEmail)).status);
    expect(entity((await request(app).get('/contacts/' + contact.id)).body).email).toBe(nextEmail);
    expect(entity((await request(app).get('/deals/' + deal.id)).body).contactId).toBe(contact.id);
  });
});

describe('crm golden: search and pagination', () => {
  test('finds matching contacts by partial name and paginates results', async () => {
    const searchToken = tag('find');
    const pageToken = tag('page');
    const first = await createContact({ firstName: 'Alicia', lastName: 'Ally-' + searchToken });
    const second = await createContact({ firstName: 'Alina', lastName: 'Ally-' + searchToken });
    await createContact({ firstName: 'Boris', lastName: 'Beta-' + searchToken });
    for (let index = 0; index < 12; index += 1) await createContact({ firstName: 'Page' + index, lastName: 'Batch-' + pageToken });
    const filtered = await searchContacts('lly-' + searchToken);
    expect(filtered.status).toBe(200);
    const found = rows(filtered.body).filter((item: any) => String(item.lastName ?? '').includes('Ally-' + searchToken));
    expect(found.map((item: any) => item.email).sort()).toEqual([first.email, second.email].sort());
    const paged = await searchContacts('Batch-' + pageToken, '&limit=5');
    expect(paged.status).toBe(200);
    expect(rows(paged.body).filter((item: any) => String(item.lastName ?? '').includes(pageToken))).toHaveLength(5);
    if (typeof paged.body.total === 'number' || typeof paged.body.data?.total === 'number') expect(total(paged.body)).toBe(12);
    if (typeof paged.body.count === 'number' || typeof paged.body.data?.count === 'number') expect([5, 12]).toContain(total(paged.body));
  });
});

describe('crm golden: validation boundaries', () => {
  test('rejects invalid contacts and deals for missing relationships', async () => {
    expect((await request(app).post('/contacts').send({ firstName: 'No', lastName: 'Email' })).status).toBe(400);
    expect((await request(app).post('/contacts').send({ firstName: 'Bad', lastName: 'Email', email: 'not-an-email' })).status).toBe(400);
    const deleted = await createContact({ firstName: 'Ghost' });
    expect([200, 204]).toContain((await request(app).delete('/contacts/' + deleted.id)).status);
    const deal = await request(app).post('/deals').send({ contactId: deleted.id, title: 'Should fail', value: 100, status: 'open' });
    expect([400, 404, 409, 422]).toContain(deal.status);
  });
});

describe('crm golden: note flexibility', () => {
  test('allows notes with contact only, deal only, both, or neither', async () => {
    const contact = await createContact({ firstName: 'NoteFlex' });
    const deal = await createDeal(contact.id, { title: 'Flexible note deal' });
    const notes = [await createNote({ contactId: contact.id }), await createNote({ dealId: deal.id }), await createNote({ contactId: contact.id, dealId: deal.id }), await createNote()];
    expect(notes.every((note: any) => Boolean(note.id))).toBe(true);
  });
});

describe('crm golden: edge cases', () => {
  test('handles phone variants and returns 404 after delete', async () => {
    const withUndefined = await request(app).post('/contacts').send({ firstName: 'Phone', lastName: 'Undefined-' + tag('phone'), email: tag('undefined') + '@example.com', phone: undefined });
    const omitted = await request(app).post('/contacts').send({ firstName: 'Phone', lastName: 'Omitted-' + tag('phone'), email: tag('omitted') + '@example.com' });
    created(withUndefined.status);
    created(omitted.status);
    const contact = entity(withUndefined.body);
    expect([200, 204]).toContain((await request(app).delete('/contacts/' + contact.id)).status);
    expect((await request(app).get('/contacts/' + contact.id)).status).toBe(404);
  });
});
`;

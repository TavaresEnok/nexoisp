"""Fluxo sintético da marca no laboratório nativo descartável."""
import hashlib

PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwaDgAAAJUAXHIMWMAAAAAAElFTkSuQmCC'
PATH = '/api/tenant-branding'
SETTINGS = '/api/settings/portal-branding'


def verify(api, call):
    def login(email, password='demo1234'):
        result = call('/api/auth/login', {'email': email, 'password': password, 'bearer': True})
        assert result['status'] == 200, result['status']
        return result['json']['token']

    def as_user(token, path, body=None, method=None):
        return call(path, body, method=method, token=token)

    beta = login('admin@beta.demo')
    attendant = login('atendimento@alfa.demo')
    assert call(PATH)['status'] == 401
    for read in (api(PATH), as_user(beta, PATH)):
        assert read['status'] == 200 and read['json'] == {'display_name': None, 'logo': None, 'updated_at': None}, read
    assert api(PATH + '/logo')['status'] == 404
    person = api('/api/subscribers', {'name': 'Marca sintética'})
    assert person['status'] == 200, person
    access = api('/api/subscribers/' + person['json']['id'] + '/portal-access', {'email': 'marca-nativa@example.invalid', 'password': 'portal-validacao-123'})
    assert access['status'] == 200, access
    subscriber = login('marca-nativa@example.invalid', 'portal-validacao-123')
    body = {'display_name': 'Marca sintética', 'logo_action': 'replace', 'logo_content_base64': PNG}
    for token in (attendant, subscriber):
        assert as_user(token, SETTINGS, body, 'PUT')['status'] == 403
    saved = api(SETTINGS, body, method='PUT')
    assert saved['status'] == 200, saved
    metadata = saved['json']
    assert metadata['display_name'] == 'Marca sintética' and metadata['logo']['mime'] == 'image/png'
    assert as_user(subscriber, PATH)['json'] == metadata
    assert as_user(beta, PATH)['json']['display_name'] is None
    logo = as_user(subscriber, PATH + '/logo')
    assert logo['status'] == 200 and logo['headers']['content-type'].startswith('image/png')
    assert hashlib.sha256(logo['body']).hexdigest() == metadata['logo']['sha256']
    reset = api(SETTINGS, {'display_name': None, 'logo_action': 'remove'}, method='PUT')
    assert reset['status'] == 200 and reset['json']['display_name'] is None and reset['json']['logo'] is None
    assert as_user(subscriber, PATH + '/logo')['status'] == 404

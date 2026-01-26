CREATE TABLE IF NOT EXISTS drivers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT,
    contacto TEXT UNIQUE,
    password_hash TEXT,
    tipo_licencia TEXT,
    experience_level TEXT,
    status TEXT DEFAULT 'active',
    estado TEXT DEFAULT 'DISPONIBLE',
    search_status TEXT DEFAULT 'ON',
    created_at TEXT,
    verified INTEGER DEFAULT 0,
    verification_token TEXT,
    verification_expires TEXT,
    reset_token TEXT,
    reset_expires TEXT
);

CREATE TABLE IF NOT EXISTS empresas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT,
    contacto TEXT UNIQUE,
    password_hash TEXT,
    legal_name TEXT,
    address_line1 TEXT,
    city TEXT,
    search_status TEXT DEFAULT 'ON',
    created_at TEXT,
    verified INTEGER DEFAULT 0,
    verification_token TEXT,
    verification_expires TEXT,
    reset_token TEXT,
    reset_expires TEXT
);

CREATE TABLE IF NOT EXISTS events_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    company_id INTEGER,
    driver_id INTEGER,
    request_id INTEGER,
    ticket_id INTEGER,
    metadata TEXT,
    processed_at TEXT,
    process_status TEXT DEFAULT 'pending',
    last_error TEXT,
    send_attempts INTEGER DEFAULT 0
);

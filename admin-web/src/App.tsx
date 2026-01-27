import { useState, useEffect } from 'react'

const API_URL_DEFAULT = 'http://localhost:3000';

function App() {
    const [auth, setAuth] = useState<{ secret: string; billingToken: string } | null>(null);
    const [apiUrl, setApiUrl] = useState(API_URL_DEFAULT);

    if (!auth) {
        return <Login onLogin={(s, b, u) => { setAuth({ secret: s, billingToken: b }); setApiUrl(u); }} />;
    }

    return <Dashboard secret={auth.secret} billingToken={auth.billingToken} apiUrl={apiUrl} onLogout={() => setAuth(null)} />;
}

// --- LOGIN SCREEN ---
function Login({ onLogin }: { onLogin: (s: string, b: string, u: string) => void }) {
    const [secret, setSecret] = useState('');
    const [billingToken, setBillingToken] = useState('');
    const [url, setUrl] = useState(API_URL_DEFAULT);
    const [error, setError] = useState('');

    const handleLogin = async () => {
        try {
            const res = await fetch(`${url}/admin/companies?search=verify_ping`, {
                headers: { 'x-admin-secret': secret }
            });
            if (res.status === 403) throw new Error('Invalid Admin Secret');
            if (!res.ok) throw new Error('API Error or Unreachable');

            onLogin(secret, billingToken, url);
        } catch (e: any) {
            setError(e.message);
        }
    };

    return (
        <div className="container" style={{ marginTop: 100, maxWidth: 400 }}>
            <div className="card">
                <h2>🔒 Admin Access</h2>
                <div style={{ marginBottom: 15 }}>
                    <label>API URL</label><br />
                    <input value={url} onChange={e => setUrl(e.target.value)} style={{ width: '100%' }} />
                </div>
                <div style={{ marginBottom: 15 }}>
                    <label>Admin Secret (x-admin-secret)</label><br />
                    <input type="password" value={secret} onChange={e => setSecret(e.target.value)} style={{ width: '100%' }} />
                </div>
                <div style={{ marginBottom: 15 }}>
                    <label>Billing Token (x-admin-token)</label><br />
                    <input type="password" placeholder="Optional (for Ops)" value={billingToken} onChange={e => setBillingToken(e.target.value)} style={{ width: '100%' }} />
                </div>
                {error && <p className="error">{error}</p>}
                <button onClick={handleLogin} style={{ width: '100%' }}>Login</button>
            </div>
        </div>
    );
}

// --- DASHBOARD ---
function Dashboard({ secret, billingToken, apiUrl, onLogout }: any) {
    const [tab, setTab] = useState<'companies' | 'payments' | 'tickets'>('companies');

    return (
        <div className="container">
            <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <h1>DriverFlow Admin</h1>
                <button className="secondary" onClick={onLogout}>Logout</button>
            </header>

            <div className="tabs">
                <div className={`tab ${tab === 'companies' ? 'active' : ''}`} onClick={() => setTab('companies')}>Companies</div>
                <div className={`tab ${tab === 'payments' ? 'active' : ''}`} onClick={() => setTab('payments')}>Payments</div>
                <div className={`tab ${tab === 'tickets' ? 'active' : ''}`} onClick={() => setTab('tickets')}>Tickets (Ops)</div>
            </div>

            <div className="content">
                {tab === 'companies' && <CompaniesTab secret={secret} apiUrl={apiUrl} />}
                {tab === 'payments' && <PaymentsTab secret={secret} apiUrl={apiUrl} />}
                {tab === 'tickets' && <TicketsTab secret={secret} billingToken={billingToken} apiUrl={apiUrl} />}
            </div>
        </div>
    );
}

// --- TABS ---

function CompaniesTab({ secret, apiUrl }: any) {
    const [data, setData] = useState<any[]>([]);
    const [search, setSearch] = useState('');

    const fetchItems = async () => {
        const res = await fetch(`${apiUrl}/admin/companies?search=${search}`, { headers: { 'x-admin-secret': secret } });
        if (res.ok) setData(await res.json());
    };

    useEffect(() => { fetchItems(); }, []);

    return (
        <div className="card">
            <div style={{ marginBottom: 15 }}>
                <input placeholder="Search company..." value={search} onChange={e => setSearch(e.target.value)} />
                <button onClick={fetchItems}>Search</button>
            </div>
            <table>
                <thead><tr><th>ID</th><th>Name</th><th>Contact</th><th>Status</th><th>Verified</th><th>Joined</th></tr></thead>
                <tbody>
                    {data.map(c => (
                        <tr key={c.id}>
                            <td>{c.id}</td>
                            <td>{c.nombre}</td>
                            <td>{c.contacto}</td>
                            <td>{c.search_status} {c.is_blocked ? '(BLOCKED)' : ''}</td>
                            <td>{c.verified ? '✅' : '❌'}</td>
                            <td>{new Date(c.created_at).toLocaleDateString()}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function PaymentsTab({ secret, apiUrl }: any) {
    const [data, setData] = useState<any[]>([]);

    const fetchItems = async () => {
        const res = await fetch(`${apiUrl}/admin/payments`, { headers: { 'x-admin-secret': secret } });
        if (res.ok) setData(await res.json());
    };

    useEffect(() => { fetchItems(); }, []);

    return (
        <div className="card">
            <div style={{ marginBottom: 15 }}><button onClick={fetchItems}>Refresh</button></div>
            <table>
                <thead><tr><th>ID</th><th>Company</th><th>Status</th><th>Amount</th><th>Issued</th><th>Paid At</th></tr></thead>
                <tbody>
                    {data.map(i => (
                        <tr key={i.id}>
                            <td>{i.id}</td>
                            <td>{i.company_name}</td>
                            <td><span className={`badge ${i.status}`}>{i.status}</span></td>
                            <td>{(i.total_cents / 100).toFixed(2)} {i.currency}</td>
                            <td>{new Date(i.created_at).toLocaleDateString()}</td>
                            <td>{i.paid_at ? new Date(i.paid_at).toLocaleString() : '-'}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function TicketsTab({ secret, billingToken, apiUrl }: any) {
    const [data, setData] = useState<any[]>([]);
    const [modalAction, setModalAction] = useState<any>(null); // { type: 'pay'|'void', item: ticket }

    const fetchItems = async () => {
        const res = await fetch(`${apiUrl}/admin/tickets`, { headers: { 'x-admin-secret': secret } });
        if (res.ok) setData(await res.json());
    };

    useEffect(() => { fetchItems(); }, []);

    const executeAction = async (payload: any) => {
        const endpoint = modalAction.type === 'pay' ? 'mark_paid' : 'void';
        const body = modalAction.type === 'pay'
            ? { payment_ref: payload.ref, billing_notes: payload.notes }
            : { billing_notes: payload.notes };

        try {
            const res = await fetch(`${apiUrl}/admin/tickets/${modalAction.item.id}/${endpoint}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-admin-secret': secret,
                    'x-admin-token': billingToken
                },
                body: JSON.stringify(body)
            });

            if (!res.ok) {
                const txt = await res.json();
                alert('Error: ' + (txt.error || 'Unknown'));
            } else {
                alert('Success!');
                setModalAction(null);
                fetchItems();
            }
        } catch (e: any) {
            alert('Net Error: ' + e.message);
        }
    };

    return (
        <div className="card">
            <div style={{ marginBottom: 15 }}><button onClick={fetchItems}>Refresh</button></div>
            <table>
                <thead><tr><th>ID</th><th>Company</th><th>Driver</th><th>Status</th><th>Amount</th><th>Actions</th></tr></thead>
                <tbody>
                    {data.map(t => (
                        <tr key={t.id}>
                            <td>{t.id}</td>
                            <td>{t.company_name}</td>
                            <td>{t.driver_name}</td>
                            <td><span className={`badge ${t.billing_status}`}>{t.billing_status}</span></td>
                            <td>{(t.amount_cents / 100).toFixed(2)}</td>
                            <td>
                                {t.billing_status === 'pending' || t.billing_status === 'unbilled' ? (
                                    <>
                                        <button className="success" style={{ marginRight: 5 }} onClick={() => setModalAction({ type: 'pay', item: t })}>Pay</button>
                                        <button className="danger" onClick={() => setModalAction({ type: 'void', item: t })}>Void</button>
                                    </>
                                ) : '-'}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>

            {modalAction && (
                <ActionModal
                    action={modalAction.type}
                    item={modalAction.item}
                    onClose={() => setModalAction(null)}
                    onSubmit={executeAction}
                />
            )}
        </div>
    );
}

function ActionModal({ action, item, onClose, onSubmit }: any) {
    const [ref, setRef] = useState('');
    const [notes, setNotes] = useState('');

    return (
        <div className="modal-overlay">
            <div className="modal">
                <h3>{action === 'pay' ? 'Mark Paid' : 'Void Ticket'} #{item.id}</h3>
                {action === 'pay' && (
                    <div style={{ marginBottom: 10 }}>
                        <label>Payment Reference</label>
                        <input value={ref} onChange={e => setRef(e.target.value)} style={{ width: '100%', boxSizing: 'border-box' }} />
                    </div>
                )}
                <div style={{ marginBottom: 10 }}>
                    <label>Notes</label>
                    <textarea value={notes} onChange={e => setNotes(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', height: 60 }} />
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
                    <button className="secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
                    <button className={action === 'pay' ? 'success' : 'danger'} onClick={() => onSubmit({ ref, notes })} style={{ flex: 1 }}>
                        Confirm
                    </button>
                </div>
            </div>
        </div>
    );
}

export default App

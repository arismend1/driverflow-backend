-- Archivo: scripts/manual_migration_stripe_webhook_events.sql
-- Descripción: Tabla de idempotencia rigurosa para Eventos Webhook de Stripe.
-- Prevención OBLIGATORIA de duplicidad (Race Conditions de red) para cargos.

CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
    stripe_event_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP WITH TIME ZONE
);

-- Índices recomendados por rendimiento para consultas Dunning/Dashboard
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_status ON public.stripe_webhook_events(status);
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_type ON public.stripe_webhook_events(type);

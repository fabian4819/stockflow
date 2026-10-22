-- Stock values below are the result AFTER the initial receipts and the sample
-- orders further down, so products.stock always equals sum(in) - sum(out).
INSERT INTO products (sku, name, price, stock, is_active, created_at) VALUES
    ('BRG-001', 'Beras Premium 5kg',               78500, 110, TRUE,  now() - interval '10 days'),
    ('BRG-002', 'Minyak Goreng 2L',                38900,  80, TRUE,  now() - interval '10 days'),
    ('BRG-003', 'Gula Pasir 1kg',                  17500, 180, TRUE,  now() - interval '10 days'),
    ('BRG-004', 'Tepung Terigu 1kg',               13200,  64, TRUE,  now() - interval '10 days'),
    ('BRG-005', 'Kopi Bubuk 200g',                 32000,   8, TRUE,  now() - interval '10 days'),
    ('BRG-006', 'Teh Celup isi 25',                 9800, 140, TRUE,  now() - interval '10 days'),
    ('BRG-007', 'Susu UHT Full Cream 1L',          19900,   6, TRUE,  now() - interval '9 days'),
    ('BRG-008', 'Mie Instan Goreng (karton 40)',  115000,  30, TRUE,  now() - interval '9 days'),
    ('BRG-009', 'Air Mineral 600ml (karton 24)',   52000,  45, TRUE,  now() - interval '9 days'),
    ('BRG-010', 'Sabun Cuci Piring 780ml',         16500,  72, TRUE,  now() - interval '8 days'),
    ('BRG-011', 'Deterjen Bubuk 1.8kg',            42500,   3, TRUE,  now() - interval '8 days'),
    ('BRG-012', 'Kecap Manis 520ml',               24700,  55, TRUE,  now() - interval '8 days'),
    ('BRG-013', 'Saus Sambal 340ml',               14900,   0, FALSE, now() - interval '2 days'),
    ('BRG-014', 'Garam Beryodium 500g',             4500,   0, TRUE,  now() - interval '1 day');

-- Initial goods receipt. BRG-013 and BRG-014 have no history (so they can be deleted).
INSERT INTO stock_movements (product_id, type, qty, note, created_at)
SELECT p.id, 'in', r.qty, 'Initial stock', now() - r.ago
FROM (VALUES
    ('BRG-001', 120, interval '7 days'),
    ('BRG-002',  85, interval '7 days'),
    ('BRG-003', 200, interval '7 days'),
    ('BRG-004',  64, interval '6 days'),
    ('BRG-005',   8, interval '6 days'),
    ('BRG-006', 150, interval '6 days'),
    ('BRG-007',   6, interval '5 days'),
    ('BRG-008',  30, interval '5 days'),
    ('BRG-009',  45, interval '4 days'),
    ('BRG-010',  72, interval '4 days'),
    ('BRG-011',   3, interval '3 hours'),
    ('BRG-012',  55, interval '40 minutes')
) AS r(sku, qty, ago)
JOIN products p ON p.sku = r.sku;

-- Sample orders. Totals are qty * unit_price, matching what the API computes.
INSERT INTO sales_orders (id, customer, status, total, created_at, cancelled_at) VALUES
    (1, 'Toko Sinar Jaya', 'CREATED',   979500, now() - interval '2 days',  NULL),
    (2, 'Warung Bu Siti',  'CREATED',   448000, now() - interval '5 hours', NULL),
    (3, 'CV Maju Bersama', 'CANCELLED', 230000, now() - interval '1 day',   now() - interval '20 hours');

INSERT INTO sales_order_items (order_id, sku, qty, unit_price) VALUES
    (1, 'BRG-001', 10, 78500),
    (1, 'BRG-002',  5, 38900),
    (2, 'BRG-003', 20, 17500),
    (2, 'BRG-006', 10,  9800),
    (3, 'BRG-008',  2, 115000);

INSERT INTO stock_movements (product_id, type, qty, note, created_at)
SELECT p.id, m.type, m.qty, m.note, now() - m.ago
FROM (VALUES
    ('BRG-001', 'out', 10, 'Order #1',           interval '2 days'),
    ('BRG-002', 'out',  5, 'Order #1',           interval '2 days'),
    ('BRG-003', 'out', 20, 'Order #2',           interval '5 hours'),
    ('BRG-006', 'out', 10, 'Order #2',           interval '5 hours'),
    ('BRG-008', 'out',  2, 'Order #3',           interval '1 day'),
    ('BRG-008', 'in',   2, 'Order #3 cancelled', interval '20 hours')
) AS m(sku, type, qty, note, ago)
JOIN products p ON p.sku = m.sku;

SELECT setval('sales_orders_id_seq', (SELECT max(id) FROM sales_orders));

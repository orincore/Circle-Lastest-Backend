import { Client } from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runRefundsMigration() {
  const client = new Client({
    host: 'localhost',
    port: 5432,
    database: 'circle_dev',
    user: 'postgres',
    password: 'password', // Update this if your password is different
  });

  try {
    await client.connect();

    // Read the migration file
    const migrationPath = path.join(__dirname, 'migrations', 'create_refunds_table.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

    // Execute the migration
    await client.query(migrationSQL);

    // Test if the table was created
    const result = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = 'refunds'
    `);

    if (result.rows.length > 0) {
    } else {
    }

    // Test the refund functions
    const statsResult = await client.query('SELECT get_refund_stats()');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
  } finally {
    await client.end();
  }
}

runRefundsMigration();

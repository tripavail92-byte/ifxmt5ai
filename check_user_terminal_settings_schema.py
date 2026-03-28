import os
import psycopg
import json

DB_CONFIG = {
    'host': 'db.agipjfxfdygfilriffxv.supabase.co',
    'dbname': 'postgres',
    'user': 'postgres',
    'password': 'Ahsan123!',
    'sslmode': 'require',
}

conn_str = f"postgresql://{DB_CONFIG['user']}:{DB_CONFIG['password']}@{DB_CONFIG['host']}:5432/{DB_CONFIG['dbname']}?sslmode={DB_CONFIG['sslmode']}"

with psycopg.connect(conn_str) as conn:
    with conn.cursor() as cur:
        # Check table definition
        cur.execute("""
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'user_terminal_settings'
            ORDER BY ordinal_position
        """)
        columns = cur.fetchall()

        # Check primary key
        cur.execute("""
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
            WHERE tc.table_schema = 'public' AND tc.table_name = 'user_terminal_settings' AND tc.constraint_type = 'PRIMARY KEY'
        """)
        pk = cur.fetchall()

        # Check foreign key
        cur.execute("""
            SELECT kcu.column_name, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
            FROM information_schema.table_constraints AS tc
            JOIN information_schema.key_column_usage AS kcu
              ON tc.constraint_name = kcu.constraint_name
            JOIN information_schema.constraint_column_usage AS ccu
              ON ccu.constraint_name = tc.constraint_name
            WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name='user_terminal_settings'
        """)
        fks = cur.fetchall()

        # Check triggers
        cur.execute("""
            SELECT trigger_name, event_manipulation, action_statement
            FROM information_schema.triggers
            WHERE event_object_table = 'user_terminal_settings'
        """)
        triggers = cur.fetchall()

        # Check functions
        cur.execute("""
            SELECT routine_name, routine_definition
            FROM information_schema.routines
            WHERE routine_type='FUNCTION' AND specific_schema='public'
        """)
        functions = cur.fetchall()

        # Check RLS policies
        cur.execute("""
            SELECT polname, polcmd, polpermissive, polroles, polqual, polwithcheck
            FROM pg_policies
            WHERE schemaname = 'public' AND tablename = 'user_terminal_settings'
        """)
        policies = cur.fetchall()

        # Print results
        print('COLUMNS:', json.dumps(columns, indent=2))
        print('PRIMARY_KEY:', json.dumps(pk, indent=2))
        print('FOREIGN_KEYS:', json.dumps(fks, indent=2))
        print('TRIGGERS:', json.dumps(triggers, indent=2))
        print('FUNCTIONS:', json.dumps(functions, indent=2))
        print('RLS_POLICIES:', json.dumps(policies, indent=2))

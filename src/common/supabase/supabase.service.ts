import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private readonly _client: SupabaseClient;
  private readonly _adminClient: SupabaseClient;

  constructor(private config: ConfigService) {
    this._client = createClient(
      this.config.getOrThrow('SUPABASE_URL'),
      this.config.getOrThrow('SUPABASE_ANON_KEY'),
    );

    this._adminClient = createClient(
      this.config.getOrThrow('SUPABASE_URL'),
      this.config.getOrThrow('SUPABASE_SERVICE_ROLE_KEY'),
    );
  }

  /** Public (RLS-enforced) client */
  get client(): SupabaseClient {
    return this._client;
  }

  /** Service-role client – bypasses RLS. Use only server-side. */
  get admin(): SupabaseClient {
    return this._adminClient;
  }

  /** Returns a user-scoped client using their JWT */
  userClient(accessToken: string): SupabaseClient {
    return createClient(
      this.config.getOrThrow('SUPABASE_URL'),
      this.config.getOrThrow('SUPABASE_ANON_KEY'),
      { global: { headers: { Authorization: `Bearer ${accessToken}` } } },
    );
  }
}

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      room_activity: {
        Row: {
          actor_id: string | null
          created_at: string
          id: string
          kind: Database["public"]["Enums"]["room_activity_kind"]
          room_id: string
          subject: string | null
          version: number | null
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          id?: string
          kind: Database["public"]["Enums"]["room_activity_kind"]
          room_id: string
          subject?: string | null
          version?: number | null
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["room_activity_kind"]
          room_id?: string
          subject?: string | null
          version?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "room_activity_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_activity_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      room_canvas_ops: {
        Row: {
          actor_kind: string
          command: Json
          created_at: string
          created_by: string | null
          revision: number
          room_id: string
        }
        Insert: {
          actor_kind: string
          command: Json
          created_at?: string
          created_by?: string | null
          revision: number
          room_id: string
        }
        Update: {
          actor_kind?: string
          command?: Json
          created_at?: string
          created_by?: string | null
          revision?: number
          room_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "room_canvas_ops_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_canvas_ops_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      room_canvases: {
        Row: {
          document: Json
          revision: number
          room_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          document: Json
          revision: number
          room_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          document?: Json
          revision?: number
          room_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "room_canvases_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: true
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_canvases_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      room_comments: {
        Row: {
          author_kind: string
          body: string
          created_at: string
          created_by: string
          id: string
          room_id: string
          thread_id: string
        }
        Insert: {
          author_kind?: string
          body: string
          created_at?: string
          created_by?: string
          id?: string
          room_id: string
          thread_id: string
        }
        Update: {
          author_kind?: string
          body?: string
          created_at?: string
          created_by?: string
          id?: string
          room_id?: string
          thread_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "room_comments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_comments_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_comments_thread_id_room_id_fkey"
            columns: ["thread_id", "room_id"]
            isOneToOne: false
            referencedRelation: "room_threads"
            referencedColumns: ["id", "room_id"]
          },
        ]
      }
      room_decision_versions: {
        Row: {
          created_at: string
          decision_id: string
          proposed_by: string
          title: string
          verify: string
          version: number
        }
        Insert: {
          created_at?: string
          decision_id: string
          proposed_by: string
          title: string
          verify: string
          version: number
        }
        Update: {
          created_at?: string
          decision_id?: string
          proposed_by?: string
          title?: string
          verify?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "room_decision_versions_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "room_decisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_decision_versions_proposed_by_fkey"
            columns: ["proposed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      room_decisions: {
        Row: {
          created_at: string
          id: string
          proposed_by: string
          room_id: string
          title: string
          updated_at: string
          verify: string
          version: number
        }
        Insert: {
          created_at?: string
          id?: string
          proposed_by?: string
          room_id: string
          title: string
          updated_at?: string
          verify: string
          version?: number
        }
        Update: {
          created_at?: string
          id?: string
          proposed_by?: string
          room_id?: string
          title?: string
          updated_at?: string
          verify?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "room_decisions_proposed_by_fkey"
            columns: ["proposed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_decisions_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      room_invitations: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          created_at: string
          domain: string | null
          email: string | null
          expires_at: string
          id: string
          invited_by: string
          kind: Database["public"]["Enums"]["invitation_kind"]
          resends: number
          revoked_at: string | null
          role: Database["public"]["Enums"]["room_role"]
          room_id: string
          sent_at: string
          status: Database["public"]["Enums"]["invitation_status"]
          token_hash: string
          uses: number
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          domain?: string | null
          email?: string | null
          expires_at: string
          id?: string
          invited_by: string
          kind: Database["public"]["Enums"]["invitation_kind"]
          resends?: number
          revoked_at?: string | null
          role?: Database["public"]["Enums"]["room_role"]
          room_id: string
          sent_at?: string
          status?: Database["public"]["Enums"]["invitation_status"]
          token_hash: string
          uses?: number
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          domain?: string | null
          email?: string | null
          expires_at?: string
          id?: string
          invited_by?: string
          kind?: Database["public"]["Enums"]["invitation_kind"]
          resends?: number
          revoked_at?: string | null
          role?: Database["public"]["Enums"]["room_role"]
          room_id?: string
          sent_at?: string
          status?: Database["public"]["Enums"]["invitation_status"]
          token_hash?: string
          uses?: number
        }
        Relationships: [
          {
            foreignKeyName: "room_invitations_accepted_by_fkey"
            columns: ["accepted_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_invitations_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_invitations_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      room_members: {
        Row: {
          joined_at: string
          role: Database["public"]["Enums"]["room_role"]
          room_id: string
          user_id: string
        }
        Insert: {
          joined_at?: string
          role?: Database["public"]["Enums"]["room_role"]
          room_id: string
          user_id: string
        }
        Update: {
          joined_at?: string
          role?: Database["public"]["Enums"]["room_role"]
          room_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "room_members_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      room_signatures: {
        Row: {
          decision_id: string
          signed_at: string
          user_id: string
          version: number
        }
        Insert: {
          decision_id: string
          signed_at?: string
          user_id?: string
          version: number
        }
        Update: {
          decision_id?: string
          signed_at?: string
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "room_signatures_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "room_decisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_signatures_decision_id_version_fkey"
            columns: ["decision_id", "version"]
            isOneToOne: false
            referencedRelation: "room_decision_versions"
            referencedColumns: ["decision_id", "version"]
          },
          {
            foreignKeyName: "room_signatures_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      room_threads: {
        Row: {
          anchor_id: string
          anchor_name: string
          anchor_x: number | null
          anchor_y: number | null
          body: string
          created_at: string
          created_by: string
          id: string
          kind: Database["public"]["Enums"]["thread_kind"]
          resolved_at: string | null
          room_id: string
        }
        Insert: {
          anchor_id: string
          anchor_name: string
          anchor_x?: number | null
          anchor_y?: number | null
          body: string
          created_at?: string
          created_by?: string
          id?: string
          kind?: Database["public"]["Enums"]["thread_kind"]
          resolved_at?: string | null
          room_id: string
        }
        Update: {
          anchor_id?: string
          anchor_name?: string
          anchor_x?: number | null
          anchor_y?: number | null
          body?: string
          created_at?: string
          created_by?: string
          id?: string
          kind?: Database["public"]["Enums"]["thread_kind"]
          resolved_at?: string | null
          room_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "room_threads_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_threads_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      room_visits: {
        Row: {
          room_id: string
          seen_at: string
          user_id: string
        }
        Insert: {
          room_id: string
          seen_at?: string
          user_id?: string
        }
        Update: {
          room_id?: string
          seen_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "room_visits_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_visits_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      rooms: {
        Row: {
          created_at: string
          created_by: string
          goal: string | null
          id: string
          name: string
          repository: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string
          goal?: string | null
          id?: string
          name: string
          repository?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          goal?: string | null
          id?: string
          name?: string
          repository?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rooms_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rooms_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string
          id: string
          name: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email: string
          id: string
          name?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string
          id?: string
          name?: string | null
        }
        Relationships: []
      }
      workspace_members: {
        Row: {
          joined_at: string
          role: Database["public"]["Enums"]["workspace_role"]
          user_id: string
          workspace_id: string
        }
        Insert: {
          joined_at?: string
          role?: Database["public"]["Enums"]["workspace_role"]
          user_id: string
          workspace_id: string
        }
        Update: {
          joined_at?: string
          role?: Database["public"]["Enums"]["workspace_role"]
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          created_at: string
          created_by: string
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          created_by?: string
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspaces_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_room_invitation: {
        Args: { invitation?: string; token?: string }
        Returns: string
      }
      commit_canvas: {
        Args: {
          actor_kind?: string
          base_revision: number
          command: Json
          document: Json
          room: string
        }
        Returns: number
      }
      create_room_link: {
        Args: {
          link_role: Database["public"]["Enums"]["room_role"]
          only_domain?: string
          room: string
          valid_for: string
        }
        Returns: {
          expires_at: string
          invitation_id: string
          token: string
        }[]
      }
      invite_to_room: {
        Args: {
          emails: string[]
          invite_role?: Database["public"]["Enums"]["room_role"]
          room: string
        }
        Returns: {
          invitation_id: string
          invited_email: string
          resent: boolean
        }[]
      }
      my_room_invitations: {
        Args: never
        Returns: {
          expires_at: string
          invitation_id: string
          inviter_name: string
          role: Database["public"]["Enums"]["room_role"]
          room_id: string
          room_name: string
          sent_at: string
        }[]
      }
      resolve_room_invitation: {
        Args: { invitation?: string; token?: string }
        Returns: Json
      }
      revoke_room_invitation: {
        Args: { invitation: string }
        Returns: undefined
      }
    }
    Enums: {
      invitation_kind: "email" | "link"
      invitation_status: "pending" | "accepted" | "expired" | "revoked"
      room_activity_kind:
        | "thread"
        | "reply"
        | "decision"
        | "amended"
        | "signed"
        | "repository"
        | "call-started"
        | "call-left"
        | "joined"
        | "left"
        | "removed"
        | "role"
      room_role: "owner" | "member" | "viewer"
      thread_kind:
        | "note"
        | "concern"
        | "avoid"
        | "constraint"
        | "question"
        | "goal"
      workspace_role: "owner" | "member"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      invitation_kind: ["email", "link"],
      invitation_status: ["pending", "accepted", "expired", "revoked"],
      room_activity_kind: [
        "thread",
        "reply",
        "decision",
        "amended",
        "signed",
        "repository",
        "call-started",
        "call-left",
        "joined",
        "left",
        "removed",
        "role",
      ],
      room_role: ["owner", "member", "viewer"],
      thread_kind: [
        "note",
        "concern",
        "avoid",
        "constraint",
        "question",
        "goal",
      ],
      workspace_role: ["owner", "member"],
    },
  },
} as const

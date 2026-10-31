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
      attention_done: {
        Row: {
          at: string
          item_id: string
          room_id: string
          user_id: string
        }
        Insert: {
          at?: string
          item_id: string
          room_id: string
          user_id?: string
        }
        Update: {
          at?: string
          item_id?: string
          room_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "attention_done_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attention_done_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      decision_alternatives: {
        Row: {
          author_kind: string
          created_at: string
          created_by: string
          decision_id: string
          id: string
          position: number
          room_id: string
          state: string
          title: string
          version: number
          why: string
        }
        Insert: {
          author_kind?: string
          created_at?: string
          created_by: string
          decision_id: string
          id?: string
          position: number
          room_id: string
          state?: string
          title: string
          version: number
          why?: string
        }
        Update: {
          author_kind?: string
          created_at?: string
          created_by?: string
          decision_id?: string
          id?: string
          position?: number
          room_id?: string
          state?: string
          title?: string
          version?: number
          why?: string
        }
        Relationships: [
          {
            foreignKeyName: "decision_alternatives_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decision_alternatives_decision_id_version_fkey"
            columns: ["decision_id", "version"]
            isOneToOne: false
            referencedRelation: "room_decision_versions"
            referencedColumns: ["decision_id", "version"]
          },
          {
            foreignKeyName: "decision_alternatives_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      decision_lines: {
        Row: {
          author_kind: string
          basis: string | null
          created_at: string
          created_by: string
          decision_id: string
          edited_by: string | null
          evidence: string[]
          how: string
          id: string
          kind: string
          position: number
          room_id: string
          suggest: Json | null
          text: string
          updated_at: string
          version: number
          was: string | null
        }
        Insert: {
          author_kind?: string
          basis?: string | null
          created_at?: string
          created_by: string
          decision_id: string
          edited_by?: string | null
          evidence?: string[]
          how?: string
          id?: string
          kind: string
          position: number
          room_id: string
          suggest?: Json | null
          text: string
          updated_at?: string
          version: number
          was?: string | null
        }
        Update: {
          author_kind?: string
          basis?: string | null
          created_at?: string
          created_by?: string
          decision_id?: string
          edited_by?: string | null
          evidence?: string[]
          how?: string
          id?: string
          kind?: string
          position?: number
          room_id?: string
          suggest?: Json | null
          text?: string
          updated_at?: string
          version?: number
          was?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "decision_lines_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decision_lines_decision_id_version_fkey"
            columns: ["decision_id", "version"]
            isOneToOne: false
            referencedRelation: "room_decision_versions"
            referencedColumns: ["decision_id", "version"]
          },
          {
            foreignKeyName: "decision_lines_edited_by_fkey"
            columns: ["edited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decision_lines_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      decision_reviewers: {
        Row: {
          changes_text: string | null
          decision_id: string
          requested_at: string
          requested_by: string | null
          room_id: string
          user_id: string
          version: number
        }
        Insert: {
          changes_text?: string | null
          decision_id: string
          requested_at?: string
          requested_by?: string | null
          room_id: string
          user_id: string
          version: number
        }
        Update: {
          changes_text?: string | null
          decision_id?: string
          requested_at?: string
          requested_by?: string | null
          room_id?: string
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "decision_reviewers_decision_id_version_fkey"
            columns: ["decision_id", "version"]
            isOneToOne: false
            referencedRelation: "room_decision_versions"
            referencedColumns: ["decision_id", "version"]
          },
          {
            foreignKeyName: "decision_reviewers_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decision_reviewers_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decision_reviewers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      inbox_state: {
        Row: {
          marks: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          marks?: Json
          updated_at?: string
          user_id?: string
        }
        Update: {
          marks?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inbox_state_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_changes: {
        Row: {
          after: string | null
          after_set: boolean
          decided_at: string | null
          decided_by: string | null
          id: string
          kind: string
          list: string | null
          note: string | null
          position: number
          revision_id: string
          room_id: string
          seed: Json | null
          state: string
          step: string | null
          text: string | null
          title: string | null
          work_id: string
        }
        Insert: {
          after?: string | null
          after_set?: boolean
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          kind: string
          list?: string | null
          note?: string | null
          position: number
          revision_id: string
          room_id: string
          seed?: Json | null
          state?: string
          step?: string | null
          text?: string | null
          title?: string | null
          work_id: string
        }
        Update: {
          after?: string | null
          after_set?: boolean
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          kind?: string
          list?: string | null
          note?: string | null
          position?: number
          revision_id?: string
          room_id?: string
          seed?: Json | null
          state?: string
          step?: string | null
          text?: string | null
          title?: string | null
          work_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_changes_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_changes_revision_id_fkey"
            columns: ["revision_id"]
            isOneToOne: false
            referencedRelation: "plan_revisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_changes_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_changes_work_id_fkey"
            columns: ["work_id"]
            isOneToOne: false
            referencedRelation: "room_work"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_revisions: {
        Row: {
          author_kind: string
          base_version: number
          closed_at: string | null
          created_at: string
          created_by: string
          from_thread: string | null
          id: string
          room_id: string
          why: string
          work_id: string
        }
        Insert: {
          author_kind?: string
          base_version: number
          closed_at?: string | null
          created_at?: string
          created_by: string
          from_thread?: string | null
          id?: string
          room_id: string
          why: string
          work_id: string
        }
        Update: {
          author_kind?: string
          base_version?: number
          closed_at?: string | null
          created_at?: string
          created_by?: string
          from_thread?: string | null
          id?: string
          room_id?: string
          why?: string
          work_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_revisions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_revisions_from_thread_fkey"
            columns: ["from_thread"]
            isOneToOne: false
            referencedRelation: "room_threads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_revisions_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_revisions_work_id_fkey"
            columns: ["work_id"]
            isOneToOne: false
            referencedRelation: "room_work"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_versions: {
        Row: {
          approved: Json | null
          approved_at: string | null
          approved_by: string | null
          body: Json
          created_at: string
          doer: Json | null
          prs: string
          room_id: string
          shaped_by: string[]
          version: number
          work_id: string
        }
        Insert: {
          approved?: Json | null
          approved_at?: string | null
          approved_by?: string | null
          body: Json
          created_at?: string
          doer?: Json | null
          prs?: string
          room_id: string
          shaped_by?: string[]
          version: number
          work_id: string
        }
        Update: {
          approved?: Json | null
          approved_at?: string | null
          approved_by?: string | null
          body?: Json
          created_at?: string
          doer?: Json | null
          prs?: string
          room_id?: string
          shaped_by?: string[]
          version?: number
          work_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_versions_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_versions_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_versions_work_id_fkey"
            columns: ["work_id"]
            isOneToOne: false
            referencedRelation: "room_work"
            referencedColumns: ["id"]
          },
        ]
      }
      room_activity: {
        Row: {
          actor_id: string | null
          created_at: string
          id: string
          kind: Database["public"]["Enums"]["room_activity_kind"]
          room_id: string
          subject: string | null
          subject_id: string | null
          version: number | null
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          id?: string
          kind: Database["public"]["Enums"]["room_activity_kind"]
          room_id: string
          subject?: string | null
          subject_id?: string | null
          version?: number | null
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["room_activity_kind"]
          room_id?: string
          subject?: string | null
          subject_id?: string | null
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
          offer: Json | null
          offer_at: string | null
          offer_by: string | null
          offer_state: string | null
          parent_id: string | null
          room_id: string
          thread_id: string
        }
        Insert: {
          author_kind?: string
          body: string
          created_at?: string
          created_by?: string
          id?: string
          offer?: Json | null
          offer_at?: string | null
          offer_by?: string | null
          offer_state?: string | null
          parent_id?: string | null
          room_id: string
          thread_id: string
        }
        Update: {
          author_kind?: string
          body?: string
          created_at?: string
          created_by?: string
          id?: string
          offer?: Json | null
          offer_at?: string | null
          offer_by?: string | null
          offer_state?: string | null
          parent_id?: string | null
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
            foreignKeyName: "room_comments_offer_by_fkey"
            columns: ["offer_by"]
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
          author_kind: string
          created_at: string
          decision_id: string
          doc: Json | null
          proposed_by: string
          revises_version: number | null
          revises_why: string | null
          state: Database["public"]["Enums"]["decision_state"]
          title: string
          verify: string
          version: number
        }
        Insert: {
          author_kind?: string
          created_at?: string
          decision_id: string
          doc?: Json | null
          proposed_by: string
          revises_version?: number | null
          revises_why?: string | null
          state?: Database["public"]["Enums"]["decision_state"]
          title: string
          verify: string
          version: number
        }
        Update: {
          author_kind?: string
          created_at?: string
          decision_id?: string
          doc?: Json | null
          proposed_by?: string
          revises_version?: number | null
          revises_why?: string | null
          state?: Database["public"]["Enums"]["decision_state"]
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
          from_thread: string | null
          id: string
          parts: string[]
          proposed_by: string
          room_id: string
          title: string
          updated_at: string
          verify: string
          version: number
        }
        Insert: {
          created_at?: string
          from_thread?: string | null
          id?: string
          parts?: string[]
          proposed_by?: string
          room_id: string
          title: string
          updated_at?: string
          verify: string
          version?: number
        }
        Update: {
          created_at?: string
          from_thread?: string | null
          id?: string
          parts?: string[]
          proposed_by?: string
          room_id?: string
          title?: string
          updated_at?: string
          verify?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "room_decisions_from_thread_fkey"
            columns: ["from_thread"]
            isOneToOne: false
            referencedRelation: "room_threads"
            referencedColumns: ["id"]
          },
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
          declined_at: string | null
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
          declined_at?: string | null
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
          declined_at?: string | null
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
          archived_at: string | null
          joined_at: string
          pin_order: number | null
          role: Database["public"]["Enums"]["room_role"]
          room_id: string
          user_id: string
        }
        Insert: {
          archived_at?: string | null
          joined_at?: string
          pin_order?: number | null
          role?: Database["public"]["Enums"]["room_role"]
          room_id: string
          user_id: string
        }
        Update: {
          archived_at?: string | null
          joined_at?: string
          pin_order?: number | null
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
      room_sessions: {
        Row: {
          activity: string | null
          agent: string
          attached_at: string
          attached_by: string | null
          branch: string | null
          changed_files: number | null
          last_seen_at: string | null
          repository: string
          room_id: string
          session_id: string
          status: string
          status_at: string | null
          title: string
          waiting_on: string | null
        }
        Insert: {
          activity?: string | null
          agent?: string
          attached_at?: string
          attached_by?: string | null
          branch?: string | null
          changed_files?: number | null
          last_seen_at?: string | null
          repository: string
          room_id: string
          session_id: string
          status?: string
          status_at?: string | null
          title: string
          waiting_on?: string | null
        }
        Update: {
          activity?: string | null
          agent?: string
          attached_at?: string
          attached_by?: string | null
          branch?: string | null
          changed_files?: number | null
          last_seen_at?: string | null
          repository?: string
          room_id?: string
          session_id?: string
          status?: string
          status_at?: string | null
          title?: string
          waiting_on?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "room_sessions_attached_by_fkey"
            columns: ["attached_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_sessions_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
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
          about_kind: string
          about_parent: string | null
          anchor_id: string
          anchor_name: string
          anchor_x: number | null
          anchor_y: number | null
          author_kind: string
          body: string
          created_at: string
          created_by: string
          id: string
          kind: Database["public"]["Enums"]["thread_kind"]
          quote: string | null
          resolved_at: string | null
          room_id: string
          waiting_on: string | null
        }
        Insert: {
          about_kind?: string
          about_parent?: string | null
          anchor_id: string
          anchor_name: string
          anchor_x?: number | null
          anchor_y?: number | null
          author_kind?: string
          body: string
          created_at?: string
          created_by?: string
          id?: string
          kind?: Database["public"]["Enums"]["thread_kind"]
          quote?: string | null
          resolved_at?: string | null
          room_id: string
          waiting_on?: string | null
        }
        Update: {
          about_kind?: string
          about_parent?: string | null
          anchor_id?: string
          anchor_name?: string
          anchor_x?: number | null
          anchor_y?: number | null
          author_kind?: string
          body?: string
          created_at?: string
          created_by?: string
          id?: string
          kind?: Database["public"]["Enums"]["thread_kind"]
          quote?: string | null
          resolved_at?: string | null
          room_id?: string
          waiting_on?: string | null
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
          {
            foreignKeyName: "room_threads_waiting_on_fkey"
            columns: ["waiting_on"]
            isOneToOne: false
            referencedRelation: "users"
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
      room_work: {
        Row: {
          accept: Json
          ask_when: Json
          author_kind: string
          authorized_at: string | null
          authorized_by: string | null
          authorized_scope: string | null
          authorized_version: number | null
          blocks: string | null
          context: Json
          created_at: string
          created_by: string
          decision_id: string | null
          decision_version: number | null
          depends_on: string | null
          doer: Json | null
          exec: Json
          id: string
          may: Json
          may_not: Json
          owner_id: string
          parts: string[]
          plan: Json
          repo: string
          resolved_at: string | null
          resolved_by: string | null
          rev: number
          room_id: string
          state: string
          thread_id: string | null
          title: string
          updated_at: string
          verified_by: Json | null
          version: number
          why: string
        }
        Insert: {
          accept?: Json
          ask_when?: Json
          author_kind?: string
          authorized_at?: string | null
          authorized_by?: string | null
          authorized_scope?: string | null
          authorized_version?: number | null
          blocks?: string | null
          context?: Json
          created_at?: string
          created_by: string
          decision_id?: string | null
          decision_version?: number | null
          depends_on?: string | null
          doer?: Json | null
          exec?: Json
          id?: string
          may?: Json
          may_not?: Json
          owner_id: string
          parts?: string[]
          plan?: Json
          repo?: string
          resolved_at?: string | null
          resolved_by?: string | null
          rev?: number
          room_id: string
          state?: string
          thread_id?: string | null
          title: string
          updated_at?: string
          verified_by?: Json | null
          version?: number
          why?: string
        }
        Update: {
          accept?: Json
          ask_when?: Json
          author_kind?: string
          authorized_at?: string | null
          authorized_by?: string | null
          authorized_scope?: string | null
          authorized_version?: number | null
          blocks?: string | null
          context?: Json
          created_at?: string
          created_by?: string
          decision_id?: string | null
          decision_version?: number | null
          depends_on?: string | null
          doer?: Json | null
          exec?: Json
          id?: string
          may?: Json
          may_not?: Json
          owner_id?: string
          parts?: string[]
          plan?: Json
          repo?: string
          resolved_at?: string | null
          resolved_by?: string | null
          rev?: number
          room_id?: string
          state?: string
          thread_id?: string | null
          title?: string
          updated_at?: string
          verified_by?: Json | null
          version?: number
          why?: string
        }
        Relationships: [
          {
            foreignKeyName: "room_work_authorized_by_fkey"
            columns: ["authorized_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_work_blocks_fkey"
            columns: ["blocks"]
            isOneToOne: false
            referencedRelation: "room_work"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_work_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_work_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "room_decisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_work_depends_on_fkey"
            columns: ["depends_on"]
            isOneToOne: false
            referencedRelation: "room_work"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_work_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_work_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_work_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_work_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "room_threads"
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
          kept_at: string | null
          name: string
          repository: string | null
          updated_at: string
          vowe: boolean
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string
          goal?: string | null
          id?: string
          kept_at?: string | null
          name: string
          repository?: string | null
          updated_at?: string
          vowe?: boolean
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          goal?: string | null
          id?: string
          kept_at?: string | null
          name?: string
          repository?: string | null
          updated_at?: string
          vowe?: boolean
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
      thread_links: {
        Row: {
          about_id: string
          about_kind: string
          about_name: string
          about_parent: string | null
          created_at: string
          created_by: string
          room_id: string
          thread_id: string
        }
        Insert: {
          about_id: string
          about_kind: string
          about_name: string
          about_parent?: string | null
          created_at?: string
          created_by: string
          room_id: string
          thread_id: string
        }
        Update: {
          about_id?: string
          about_kind?: string
          about_name?: string
          about_parent?: string | null
          created_at?: string
          created_by?: string
          room_id?: string
          thread_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "thread_links_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "thread_links_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "thread_links_thread_id_room_id_fkey"
            columns: ["thread_id", "room_id"]
            isOneToOne: false
            referencedRelation: "room_threads"
            referencedColumns: ["id", "room_id"]
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
      work_findings: {
        Row: {
          author_kind: string
          created_at: string
          created_by: string
          evidence: string[]
          id: string
          offer: string | null
          room_id: string
          text: string
          work_id: string
        }
        Insert: {
          author_kind?: string
          created_at?: string
          created_by: string
          evidence?: string[]
          id?: string
          offer?: string | null
          room_id: string
          text: string
          work_id: string
        }
        Update: {
          author_kind?: string
          created_at?: string
          created_by?: string
          evidence?: string[]
          id?: string
          offer?: string | null
          room_id?: string
          text?: string
          work_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_findings_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_findings_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_findings_work_id_fkey"
            columns: ["work_id"]
            isOneToOne: false
            referencedRelation: "room_work"
            referencedColumns: ["id"]
          },
        ]
      }
      work_log: {
        Row: {
          at: string
          author_kind: string
          id: number
          room_id: string
          text: string
          who: string | null
          work_id: string
        }
        Insert: {
          at?: string
          author_kind?: string
          id?: never
          room_id: string
          text: string
          who?: string | null
          work_id: string
        }
        Update: {
          at?: string
          author_kind?: string
          id?: never
          room_id?: string
          text?: string
          who?: string | null
          work_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_log_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_log_who_fkey"
            columns: ["who"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_log_work_id_fkey"
            columns: ["work_id"]
            isOneToOne: false
            referencedRelation: "room_work"
            referencedColumns: ["id"]
          },
        ]
      }
      work_prs: {
        Row: {
          branch: string
          created_by: string
          id: string
          num: number
          room_id: string
          state: string
          step: string | null
          title: string
          updated_at: string
          url: string | null
          work_id: string
        }
        Insert: {
          branch?: string
          created_by: string
          id?: string
          num: number
          room_id: string
          state: string
          step?: string | null
          title: string
          updated_at?: string
          url?: string | null
          work_id: string
        }
        Update: {
          branch?: string
          created_by?: string
          id?: string
          num?: number
          room_id?: string
          state?: string
          step?: string | null
          title?: string
          updated_at?: string
          url?: string | null
          work_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_prs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_prs_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_prs_work_id_fkey"
            columns: ["work_id"]
            isOneToOne: false
            referencedRelation: "room_work"
            referencedColumns: ["id"]
          },
        ]
      }
      work_questions: {
        Row: {
          about: string
          answer: string | null
          answered_at: string | null
          answered_by: string | null
          author_kind: string
          created_at: string
          created_by: string
          deferred: boolean
          for_user: string
          id: string
          options: string[]
          room_id: string
          step: string | null
          text: string
          work_id: string
        }
        Insert: {
          about?: string
          answer?: string | null
          answered_at?: string | null
          answered_by?: string | null
          author_kind?: string
          created_at?: string
          created_by: string
          deferred?: boolean
          for_user: string
          id?: string
          options?: string[]
          room_id: string
          step?: string | null
          text: string
          work_id: string
        }
        Update: {
          about?: string
          answer?: string | null
          answered_at?: string | null
          answered_by?: string | null
          author_kind?: string
          created_at?: string
          created_by?: string
          deferred?: boolean
          for_user?: string
          id?: string
          options?: string[]
          room_id?: string
          step?: string | null
          text?: string
          work_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_questions_answered_by_fkey"
            columns: ["answered_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_questions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_questions_for_user_fkey"
            columns: ["for_user"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_questions_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_questions_work_id_fkey"
            columns: ["work_id"]
            isOneToOne: false
            referencedRelation: "room_work"
            referencedColumns: ["id"]
          },
        ]
      }
      work_scope_requests: {
        Row: {
          adds: string
          asked_as: string
          author_kind: string
          created_at: string
          created_by: string
          decided_at: string | null
          decided_by: string | null
          id: string
          room_id: string
          state: string
          text: string
          work_id: string
        }
        Insert: {
          adds: string
          asked_as: string
          author_kind?: string
          created_at?: string
          created_by: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          room_id: string
          state?: string
          text: string
          work_id: string
        }
        Update: {
          adds?: string
          asked_as?: string
          author_kind?: string
          created_at?: string
          created_by?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          room_id?: string
          state?: string
          text?: string
          work_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_scope_requests_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_scope_requests_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_scope_requests_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_scope_requests_work_id_fkey"
            columns: ["work_id"]
            isOneToOne: false
            referencedRelation: "room_work"
            referencedColumns: ["id"]
          },
        ]
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
      workspace_repositories: {
        Row: {
          added_at: string
          added_by: string | null
          repository: string
          workspace_id: string
        }
        Insert: {
          added_at?: string
          added_by?: string | null
          repository: string
          workspace_id: string
        }
        Update: {
          added_at?: string
          added_by?: string | null
          repository?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_repositories_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_repositories_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          agent_name: string
          created_at: string
          created_by: string
          id: string
          name: string
        }
        Insert: {
          agent_name?: string
          created_at?: string
          created_by?: string
          id?: string
          name: string
        }
        Update: {
          agent_name?: string
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
      decline_room_invitation: {
        Args: { invitation: string }
        Returns: undefined
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
      archive_room: {
        Args: { archive: boolean; room: string }
        Returns: string
      }
      keep_room: {
        Args: { keep: boolean; room: string }
        Returns: string
      }
      pin_room: {
        Args: { pin_order: number; room: string }
        Returns: number
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
      vowe_add_finding: {
        Args: {
          actor_kind?: string
          body: string
          evidence?: string[]
          offer?: string
          work: string
        }
        Returns: string
      }
      vowe_add_line: {
        Args: {
          actor_kind?: string
          body: string
          decision: string
          kind: string
          ver: number
        }
        Returns: string
      }
      vowe_allow_scope: {
        Args: { actor_kind?: string; allow: boolean; work: string }
        Returns: undefined
      }
      vowe_amend: {
        Args: { actor_kind?: string; decision: string }
        Returns: number
      }
      vowe_answer_offer: {
        Args: {
          accept: boolean
          actor_kind?: string
          reply: string
          room: string
          thread: string
        }
        Returns: undefined
      }
      vowe_answer_question: {
        Args: {
          actor_kind?: string
          body: string
          question: string
          work: string
        }
        Returns: undefined
      }
      vowe_ask_question: {
        Args: {
          about: string
          actor_kind?: string
          body: string
          for_user: string
          options?: string[]
          step: string
          work: string
        }
        Returns: string
      }
      vowe_authorize: {
        Args: { actor_kind?: string; ver: number; work: string }
        Returns: undefined
      }
      vowe_create_decision: {
        Args: {
          actor_kind?: string
          from_thread?: string
          line?: string
          problem?: string
          room: string
          title: string
        }
        Returns: string
      }
      vowe_create_thread: {
        Args: {
          about: Json
          actor_kind?: string
          at_x?: number
          at_y?: number
          body: string
          quote?: string
          room: string
          waiting_on?: string
        }
        Returns: string
      }
      vowe_create_work: {
        Args: {
          actor_kind?: string
          decision?: string
          decision_ver?: number
          objective?: string
          room: string
          thread?: string
          title: string
        }
        Returns: string
      }
      vowe_decide_change: {
        Args: {
          accept: boolean
          actor_kind?: string
          base: number
          change: string
          expected_rev: number
          extra?: Json
          extra_id?: string
          line?: string
          patch?: Json
          want_version?: number
          work: string
        }
        Returns: Json
      }
      vowe_defer_question: {
        Args: { actor_kind?: string; question: string; work: string }
        Returns: undefined
      }
      vowe_edit_doc: {
        Args: {
          actor_kind?: string
          body: string
          decision: string
          field: string
          ver: number
        }
        Returns: undefined
      }
      vowe_edit_line: {
        Args: {
          actor_kind?: string
          body: string
          decision: string
          line: string
          ver: number
        }
        Returns: undefined
      }
      vowe_link_thread: {
        Args: { about: Json; room: string; thread: string }
        Returns: undefined
      }
      vowe_mark_done: {
        Args: { items: string[]; room: string }
        Returns: undefined
      }
      vowe_record: { Args: { room: string }; Returns: Json }
      vowe_reply: {
        Args: {
          actor_kind?: string
          body: string
          offer?: Json
          room: string
          thread: string
        }
        Returns: string
      }
      vowe_request_changes: {
        Args: {
          actor_kind?: string
          body: string
          decision: string
          ver: number
        }
        Returns: undefined
      }
      vowe_request_scope: {
        Args: {
          actor_kind?: string
          adds: string
          asked_as: string
          body: string
          work: string
        }
        Returns: string
      }
      vowe_request_signatures: {
        Args: {
          actor_kind?: string
          decision: string
          ver: number
          who: string[]
        }
        Returns: undefined
      }
      vowe_resolve_work: {
        Args: { actor_kind?: string; work: string }
        Returns: undefined
      }
      vowe_save_plan: {
        Args: {
          actor_kind?: string
          base: number
          expected_rev: number
          line?: string
          patch: Json
          want_version?: number
          work: string
        }
        Returns: Json
      }
      vowe_set_agent_name: {
        Args: { actor_kind?: string; name: string; room: string }
        Returns: string
      }
      vowe_set_suggested: {
        Args: {
          actor_kind?: string
          decision: string
          to_state: string
          ver: number
        }
        Returns: undefined
      }
      vowe_sign: {
        Args: { actor_kind?: string; decision: string; ver: number }
        Returns: undefined
      }
      vowe_suggest_line: {
        Args: {
          actor_kind?: string
          body: string
          decision: string
          line: string
          ver: number
          why: string
        }
        Returns: undefined
      }
      vowe_suggest_revision: {
        Args: {
          actor_kind?: string
          base: number
          changes: Json
          from_thread?: string
          why: string
          work: string
        }
        Returns: string
      }
      vowe_take_suggestion: {
        Args: {
          accept: boolean
          actor_kind?: string
          decision: string
          line: string
          ver: number
        }
        Returns: undefined
      }
      vowe_track_pr: {
        Args: {
          actor_kind?: string
          branch?: string
          num: number
          state: string
          step?: string
          title: string
          url?: string
          work: string
        }
        Returns: undefined
      }
    }
    Enums: {
      decision_state:
        | "suggested"
        | "draft"
        | "review"
        | "agreed"
        | "superseded"
        | "dismissed"
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
        | "review"
        | "agreed"
        | "changes"
        | "work"
        | "plan"
        | "authorized"
        | "scope"
        | "question"
        | "finding"
        | "resolved"
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
      decision_state: [
        "suggested",
        "draft",
        "review",
        "agreed",
        "superseded",
        "dismissed",
      ],
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
        "review",
        "agreed",
        "changes",
        "work",
        "plan",
        "authorized",
        "scope",
        "question",
        "finding",
        "resolved",
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

// モック API の応答。openapi/openapi.yaml の応答例（example / examples）と同じ内容にする。
// openapi.yaml の応答例を変更したらこのファイルも同じ内容に更新し、api/contract_test.ts で一致を確認する（API09「モックと本実装で契約を変えない」）
export const FIXTURES = {
  "GET /users/{user_id}": {
    "status": 200,
    "body": {
      "data": {
        "id": "b7e2c3d4-1111-4a2b-9c3d-000000000101",
        "display_name": "ゆうき",
        "character": {
          "public_code": "C-9QX2M7KD",
          "name": "ソラカ",
          "level": 7,
          "species": "スピリット",
          "class": "メイジ",
          "attribute": "風",
          "rarity": "R",
          "title": "そよ風の旅人",
          "thumbnail_url": "https://your-project-ref.supabase.co/storage/v1/object/sign/character-images/..."
        },
        "profile_items": [
          {
            "key": "favorite_works",
            "label": "好きな作品",
            "values": [
              "作品A",
              "作品B"
            ]
          }
        ],
        "can_start_dm": true
      }
    }
  },
  "GET /me/recommendations": {
    "status": 200,
    "examples": {
      "user": {
        "data": [
          {
            "rank": 1,
            "user": {
              "id": "b7e2c3d4-1111-4a2b-9c3d-000000000101",
              "display_name": "ゆうき",
              "character": {
                "name": "ソラカ",
                "level": 7,
                "thumbnail_url": "https://your-project-ref.supabase.co/storage/v1/object/sign/character-images/..."
              }
            },
            "compatibility": {
              "value": 66,
              "display": "66%"
            },
            "matched_items": [
              {
                "question_code": "Q1",
                "label": "好きな作品",
                "values": [
                  "作品A",
                  "作品B"
                ]
              },
              {
                "question_code": "Q9",
                "label": "楽しみ方",
                "values": [
                  "視聴・読書"
                ]
              }
            ],
            "can_start_dm": true
          }
        ],
        "meta": {
          "generated_at": "2026-10-20T03:15:00Z"
        }
      },
      "guild": {
        "data": [
          {
            "rank": 1,
            "guild": {
              "id": "9c000000-0000-4000-8000-000000000001",
              "name": "ファンタジー好きの酒場",
              "member_count": 37,
              "capacity": 100,
              "tags": [
                {
                  "code": "fantasy",
                  "label": "ファンタジー"
                }
              ]
            },
            "compatibility": {
              "value": 72,
              "display": "72%"
            },
            "matched_items": [
              {
                "question_code": "Q11",
                "label": "好きなジャンル・世界観",
                "values": [
                  "ファンタジー"
                ]
              }
            ],
            "reason": "ファンタジー作品が好きなメンバーが多いギルドです"
          }
        ],
        "meta": {
          "generated_at": "2026-10-20T03:15:00Z"
        }
      },
      "work": {
        "data": [
          {
            "rank": 1,
            "work": {
              "id": "a0000000-0000-4000-8000-000000000004",
              "title": "作品D"
            },
            "matched_items": [
              {
                "question_code": "Q1",
                "label": "好きな作品",
                "values": [
                  "作品A"
                ]
              }
            ],
            "reason": "作品A が好きなあなたには、同じく仲間との絆を描く作品D がおすすめです"
          }
        ],
        "meta": {
          "generated_at": "2026-10-20T03:15:00Z"
        }
      }
    }
  },
  "GET /guilds": {
    "status": 200,
    "body": {
      "data": [
        {
          "id": "9c000000-0000-4000-8000-000000000001",
          "name": "ファンタジー好きの酒場",
          "description": "剣と魔法の世界が好きな人のギルド",
          "tags": [
            {
              "code": "fantasy",
              "label": "ファンタジー"
            }
          ],
          "member_count": 37,
          "capacity": 100,
          "is_member": false,
          "is_full": false
        },
        {
          "id": "9c000000-0000-4000-8000-000000000002",
          "name": "学園ものクラブ",
          "description": "学園作品について語るギルド",
          "tags": [
            {
              "code": "school",
              "label": "学園"
            }
          ],
          "member_count": 100,
          "capacity": 100,
          "is_member": false,
          "is_full": true
        }
      ],
      "meta": {
        "next_cursor": null
      }
    }
  },
  "GET /me/guilds": {
    "status": 200,
    "body": {
      "data": [
        {
          "id": "9c000000-0000-4000-8000-000000000001",
          "name": "ファンタジー好きの酒場",
          "description": "剣と魔法の世界が好きな人のギルド",
          "tags": [
            {
              "code": "fantasy",
              "label": "ファンタジー"
            }
          ],
          "member_count": 37,
          "capacity": 100,
          "is_member": true,
          "is_full": false
        }
      ],
      "meta": {
        "next_cursor": null
      }
    }
  },
  "GET /guilds/{guild_id}": {
    "status": 200,
    "body": {
      "data": {
        "id": "9c000000-0000-4000-8000-000000000001",
        "name": "ファンタジー好きの酒場",
        "description": "剣と魔法の世界が好きな人のギルド",
        "tags": [
          {
            "code": "fantasy",
            "label": "ファンタジー"
          }
        ],
        "member_count": 37,
        "capacity": 100,
        "is_member": true,
        "is_full": false,
        "leader_info": "運営スタッフ",
        "conversation_id": "c0000000-0000-4000-8000-000000000001",
        "my_role": "member",
        "joined_at": "2026-10-20T03:20:00Z"
      }
    }
  },
  "POST /guilds/{guild_id}/join": {
    "status": 200,
    "body": {
      "data": {
        "guild_id": "9c000000-0000-4000-8000-000000000001",
        "conversation_id": "c0000000-0000-4000-8000-000000000001",
        "member_count": 37,
        "capacity": 100
      }
    }
  },
  "GET /guilds/{guild_id}/announcements": {
    "status": 200,
    "body": {
      "data": [
        {
          "id": "4a110000-0000-4000-8000-000000000001",
          "title": "ギルドへようこそ",
          "body": "自己紹介をトークルームに書き込んでみましょう。",
          "published_at": "2026-10-20T00:00:00Z"
        }
      ],
      "meta": {
        "next_cursor": null
      }
    }
  },
  "GET /guilds/{guild_id}/members": {
    "status": 200,
    "body": {
      "data": [
        {
          "user_id": "b7e2c3d4-1111-4a2b-9c3d-000000000101",
          "display_name": "ゆうき",
          "role": "leader",
          "character": {
            "name": "ソラカ",
            "level": 7,
            "thumbnail_url": "https://your-project-ref.supabase.co/storage/v1/object/sign/character-images/..."
          },
          "joined_at": "2026-10-20T00:10:00Z"
        }
      ],
      "meta": {
        "next_cursor": null
      }
    }
  },
  "GET /conversations": {
    "status": 200,
    "body": {
      "data": [
        {
          "conversation_id": "c0000000-0000-4000-8000-0000000000d1",
          "partner": {
            "user_id": "b7e2c3d4-1111-4a2b-9c3d-000000000101",
            "display_name": "ゆうき",
            "character": {
              "name": "ソラカ",
              "level": 7,
              "thumbnail_url": "https://your-project-ref.supabase.co/storage/v1/object/sign/character-images/..."
            }
          },
          "last_message": {
            "body": "今度一緒に作品D見ませんか？",
            "created_at": "2026-10-20T04:00:00Z"
          },
          "has_unread": true,
          "unread_count": 2
        }
      ],
      "meta": {
        "next_cursor": null
      }
    }
  },
  "POST /conversations/dm": {
    "status": 200,
    "body": {
      "data": {
        "conversation_id": "c0000000-0000-4000-8000-0000000000d1",
        "created": false
      }
    }
  },
  "GET /conversations/{conversation_id}/messages": {
    "status": 200,
    "body": {
      "data": [
        {
          "id": "9a40e1f2-3333-4c5d-8e6f-000000000201",
          "conversation_id": "c0000000-0000-4000-8000-000000000001",
          "sender": {
            "type": "user",
            "user_id": "b7e2c3d4-1111-4a2b-9c3d-000000000101",
            "display_name": "ゆうき",
            "role": "leader",
            "character_thumbnail_url": "https://your-project-ref.supabase.co/storage/v1/object/sign/character-images/..."
          },
          "body": "みなさん、よろしくお願いします！",
          "image_url": null,
          "created_at": "2026-10-20T03:30:00Z",
          "goodto": {
            "total_count": 12,
            "granted_by_me": false
          }
        },
        {
          "id": "9a40e1f2-3333-4c5d-8e6f-000000000202",
          "conversation_id": "c0000000-0000-4000-8000-000000000001",
          "sender": {
            "type": "system",
            "user_id": null,
            "display_name": "CONIME",
            "role": null,
            "character_thumbnail_url": null
          },
          "body": "ゆうき さんが参加しました",
          "image_url": null,
          "created_at": "2026-10-20T03:29:00Z",
          "goodto": {
            "total_count": 0,
            "granted_by_me": false
          }
        }
      ],
      "meta": {
        "next_cursor": null
      }
    }
  },
  "POST /conversations/{conversation_id}/messages": {
    "status": 201,
    "body": {
      "data": {
        "id": "9a40e1f2-3333-4c5d-8e6f-000000000299",
        "conversation_id": "c0000000-0000-4000-8000-000000000001",
        "sender": {
          "type": "user",
          "user_id": "d0000000-0000-4000-8000-000000000002",
          "display_name": "診断済みユーザー",
          "role": "member",
          "character_thumbnail_url": "https://your-project-ref.supabase.co/storage/v1/object/sign/character-images/..."
        },
        "body": "こんにちは！",
        "image_url": null,
        "created_at": "2026-10-20T04:05:00Z",
        "goodto": {
          "total_count": 0,
          "granted_by_me": false
        }
      }
    }
  },
  "POST /conversations/{conversation_id}/read": {
    "status": 200,
    "body": {
      "data": {
        "conversation_id": "c0000000-0000-4000-8000-0000000000d1",
        "last_read_at": "2026-10-20T04:05:00Z",
        "unread_count": 0
      }
    }
  },
  "POST /uploads/message-images": {
    "status": 201,
    "body": {
      "data": {
        "upload_url": "https://your-project-ref.supabase.co/storage/v1/object/upload/sign/message-images/...",
        "image_path": "message-images/d0000000-0000-4000-8000-000000000002/5e1f0000-0000-4000-8000-000000000001.jpg",
        "expires_at": "2026-10-20T04:15:00Z",
        "max_bytes": 5242880
      }
    }
  },
  "POST /goodtos": {
    "status": 201,
    "body": {
      "data": {
        "target": {
          "type": "message",
          "id": "9a40e1f2-3333-4c5d-8e6f-000000000201"
        },
        "total_count": 12,
        "granted": true
      }
    }
  },
  "GET /me/goodtos/received": {
    "status": 200,
    "body": {
      "data": [
        {
          "id": "600d0000-0000-4000-8000-000000000001",
          "giver": {
            "user_id": "b7e2c3d4-1111-4a2b-9c3d-000000000101",
            "display_name": "ゆうき"
          },
          "target": {
            "type": "message",
            "id": "9a40e1f2-3333-4c5d-8e6f-000000000299"
          },
          "points": 1,
          "created_at": "2026-10-20T04:06:00Z"
        }
      ],
      "meta": {
        "next_cursor": null,
        "total_count": 31
      }
    }
  },
  "GET /me/growth": {
    "status": 200,
    "body": {
      "data": {
        "level": 12,
        "max_level": 100,
        "exp_total": 4820,
        "exp_current_level_start": 4500,
        "exp_next_level": 5100,
        "goodto_points": 310,
        "next_evolution_level": 15,
        "image": {
          "status": "ready",
          "url": "https://your-project-ref.supabase.co/storage/v1/object/sign/character-images/...",
          "expires_at": "2026-10-20T04:10:00Z",
          "stage": 10
        }
      }
    }
  },
  "GET /navigator/messages": {
    "status": 200,
    "body": {
      "data": [
        {
          "id": "4a710000-0000-4000-8000-000000000002",
          "role": "navigator",
          "body": "ギルドホールから気になるギルドを探せます。",
          "created_at": "2026-10-20T04:00:05Z"
        },
        {
          "id": "4a710000-0000-4000-8000-000000000001",
          "role": "user",
          "body": "ギルドに入るにはどうすればいい？",
          "created_at": "2026-10-20T04:00:00Z"
        }
      ],
      "meta": {
        "next_cursor": null,
        "remaining_today": 29,
        "daily_limit": 30
      }
    }
  },
  "POST /navigator/messages": {
    "status": 201,
    "body": {
      "data": {
        "question": {
          "id": "4a710000-0000-4000-8000-000000000001",
          "role": "user",
          "body": "ギルドに入るにはどうすればいい？",
          "created_at": "2026-10-20T04:00:00Z"
        },
        "reply": {
          "id": "4a710000-0000-4000-8000-000000000002",
          "role": "navigator",
          "body": "ギルドホールから気になるギルドを探せます。",
          "created_at": "2026-10-20T04:00:05Z"
        },
        "remaining_today": 29
      }
    }
  },
  "GET /me/notifications": {
    "status": 200,
    "body": {
      "data": [
        {
          "id": "70710000-0000-4000-8000-000000000001",
          "type": "goodto_received",
          "title": "グッとが届きました",
          "body": "ゆうき さんがあなたの発言にグッとしました",
          "link": "conime://conversations/c0000000-0000-4000-8000-000000000001",
          "created_at": "2026-10-20T04:06:00Z",
          "read_at": null
        },
        {
          "id": "70710000-0000-4000-8000-000000000002",
          "type": "level_up",
          "title": "レベルアップ！",
          "body": "ルミナが Lv.12 になりました",
          "link": "conime://me/character",
          "created_at": "2026-10-20T04:06:01Z",
          "read_at": null
        }
      ],
      "meta": {
        "next_cursor": null,
        "unread_count": 2
      }
    }
  },
  "POST /me/notifications/read": {
    "status": 200,
    "body": {
      "data": {
        "updated_count": 1,
        "unread_count": 1
      }
    }
  },
  "POST /reports": {
    "status": 201,
    "body": {
      "data": {
        "report_id": "4e900000-0000-4000-8000-000000000001",
        "status": "open",
        "created_at": "2026-10-20T04:10:00Z"
      }
    }
  },
  "GET /me/blocks": {
    "status": 200,
    "body": {
      "data": [
        {
          "user_id": "b7e2c3d4-1111-4a2b-9c3d-000000000102",
          "display_name": "ブロックしたユーザー",
          "created_at": "2026-10-20T04:12:00Z"
        }
      ],
      "meta": {
        "next_cursor": null
      }
    }
  },
  "POST /blocks": {
    "status": 201,
    "body": {
      "data": {
        "user_id": "b7e2c3d4-1111-4a2b-9c3d-000000000102",
        "display_name": "ブロックしたユーザー",
        "created_at": "2026-10-20T04:12:00Z"
      }
    }
  },
  "DELETE /blocks/{user_id}": {
    "status": 204
  },
  "POST /me/withdrawal": {
    "status": 202,
    "body": {
      "data": {
        "status": "requested",
        "requested_at": "2026-10-20T04:20:00Z",
        "purge_scheduled_at": "2026-11-19T04:20:00Z"
      }
    }
  }
} as const;

export type FixtureKey = keyof typeof FIXTURES;

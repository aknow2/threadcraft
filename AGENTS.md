# 開発ガイド

## プロジェクト

treadcraft は Codex のスレッドを整理するローカルデスクトップアプリ。
Tauri 2 / React / TypeScript / Rust / SQLite を使用する。

- `src/`: UI とフロントエンドのテスト。
- `src-tauri/`: Rust バックエンド、Tauri 設定・権限、テスト用の偽サーバー。
- `scripts/`: 診断スクリプト。
- [README.md](README.md): 起動・操作・検証手順。
- [docs/design.md](docs/design.md): 初期設計。現在の仕様とは限らない。
- [docs/implementation.md](docs/implementation.md): 実装記録と未検証事項。

変更時は現行コード・テスト・設定も確認し、古い設計や過去の検証記録だけで現在の動作を断定しない。

## 既存変更の保護

作業開始時に `git status --short` で既存変更を確認する。
作業中の変更・未追跡ファイルを無断で上書き、削除、リセットしない。
既存 Skill の置換、CI の有効化、本番デプロイは無断で行わない。
Secrets を出力・保存しない。実会話やローカル DB を検証のために無断で変更しない。

## 検証

変更対象に応じて必要な検証を選び、実行したコマンド・結果・未検証事項を報告する。
過去の成功を今回の成功として扱わない。

```sh
npm test
npm run typecheck
npm run build
npm run format:check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings
npm run tauri -- build --debug --no-bundle
```

UI の実画面確認、他 OS の確認、実 Codex 接続は自動テストと区別して記録する。
実データを使う診断は通常の自動テストに混ぜず、操作の範囲とユーザーの許可を確認する。

## レビュー方針

Copilotへのコードレビュー依頼・再依頼は停止する。PR作成やpushに伴う通常手順に含めない。ユーザーが明示的に再開を指示するまで、この方針を維持する。

## Skill / Workflow の設計と再開

- 進捗は [.agent-workflow/manifest.json](.agent-workflow/manifest.json) で管理する。
- プロジェクトの Skill は `.agents/skills/<name>/SKILL.md`、仕様は `specs/` に保存する。
- 設計メモは `.agent-workflow/decisions/{kind}-{name}.md` に保存する。
- 作成依頼では manifest と設計メモを読み、`draft` があればそこから再開する。指定対象がなければ `grill` → `specify` → `verify` → `implement` の順に候補を提案する。
- 一度に一つを設計し、基本は重要な質問を一つずつ行う。回答済み事項を聞き直さず、未解決事項を推測で確定しない。
- 設計開始時は `draft` とし、目的、確定要件、未解決の質問、判断と理由、禁止事項、完了条件、次回の質問を設計メモへ記録する。
- 生成前に目的・スコープ、仕様、変更ファイル、実行フロー、検証方法、残存リスク・制限を提示し、明示的な承認を得る。初期化への承認を個々の Skill / Workflow の仕様承認として扱わない。
- 承認後に生成し、構造、メタデータ、参照先、既存ファイルとの競合、受入条件を検証する。
- 状態は `pending`（未着手）、`draft`（設計中）、`completed`（承認・生成・検証済み）、`existing`（既存検出・品質未評価）。承認記録と検証完了が揃った対象だけを `completed` にする。
- manifest と実体の矛盾は報告する。既存対象を重複登録・無断置換しない。
- Workflow では起動条件、権限・Secrets、競合、タイムアウト・リトライ、失敗時の対応、承認ポイントも設計する。未承認の実行可能な Workflow を追加しない。

初期化の承認・検証記録は [.agent-workflow/decisions/bootstrap-initialization.md](.agent-workflow/decisions/bootstrap-initialization.md) を参照する。

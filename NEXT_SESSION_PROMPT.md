# Prompt for the next session

Paste the block below as the first message of the new session, once the repository is
attached and push access has been granted.

---

```
このリポジトリ (cadmium2525/custom_robot、ブランチ claude/custom-robo-v2-game-195efo) で
HOLOSSEUM — Three.js 製の Custom Robo V2 風ロボット対戦アクションゲーム — の開発を継続してください。

最初にやること:

1. リポジトリ直下の HANDOVER.md を読んでください。プロジェクトの現状、計測器の使い方、
   これまでに判明した不具合、未解決の課題がすべて書いてあります。
2. `git log --oneline -20` で直近の作業を確認してください。全 355 コミットがローカルにあります。
3. push 権限が付与されたので、まず `git push -u origin claude/custom-robo-v2-game-195efo` を
   実行して、これまでの全履歴をリモートに反映してください。コミットメッセージ自体が
   設計判断の記録なので、squash せずそのまま push してください。
   (PR は私が明示的に頼むまで作らないでください。)

それが終わったら、通常の開発ループを再開してください:

- HANDOVER.md の §5「Outstanding debts」の上から順に進めてください。
  最優先は uFrameLift の区間を clause A / C に対してきちんとサンプリングすることです
  (この応答は非単調なので、2 点からの内挿は禁止です)。
- 各ラウンドの最後には必ず批評エージェント (critic) を subagent として立ち上げ、
  shots/REVIEW2.md に RULING を書かせてコミットさせてください。批評は必須です。
- 批評エージェントには厳しく評価させてください。AAA 品質に達していないなら、
  達するまで作業を続けてください。
- shots/REVIEW2.md は約 15,000 行あります。全文は読まず tail と grep を使ってください。
- HANDOVER.md の §2「standing rules」と §7「traps」は必ず守ってください。
  特に: 計測値には必ず meter と bundle hash と n を添えること、
  ガードの応答を内挿しないこと、GLSL テンプレートリテラル内にバックティックを書かないこと。

報告は簡潔にしてトークンを節約してください。
```

---

## Why the prompt is shaped this way

- **Push first.** The history is 355 commits whose messages carry the reasoning behind
  every decision; getting it onto the remote before anything else is the one irreversible
  win available at the start of the session.
- **It points at `HANDOVER.md` rather than restating it.** A long prompt would be re-read
  and re-summarised every context window; a short pointer to a file in the repo is read once,
  when it is needed.
- **It names the first task concretely** (`uFrameLift` sampling) so the session does not
  spend a round deciding what to do.
- **It makes the critic mandatory and harsh**, which is the mechanism that has produced
  nearly all the real findings in this project, including the ones that overturned the
  builder's own conclusions.
- **It repeats the three rules most often broken** rather than all eight, because a prompt
  that lists everything gets skimmed.

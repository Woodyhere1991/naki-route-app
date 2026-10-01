# Your private Naki records

Double-click **Naki private records** on your desktop to search your own saved Jotform submissions. Select a row to read every original answer. **Lock and close** closes the viewer without writing an unencrypted export. The viewer runs locally and does not send the archive to a website.

The protected archive is in your `Naki-Private` folder. A verified encrypted copy is also on your D: backup drive. **Copy encrypted archive** lets you save another protected copy.

The archive uses Windows encryption tied to the Windows account and profile that created it. A file copy alone does not make it recoverable on a replacement computer without that profile and its encryption keys. Keep the original Windows profile and its backup. Ask for a password-protected portable copy before replacing or resetting this computer.

These are the original source answers, including tests, historical Deleted labels and incorrect original calculator values. Your Naki app uses the corrected earnings and excludes the identified family tests.

An alternate archive can be opened with `OPEN-PRIVATE-RECORDS.cmd -ArchivePath "C:\path\saved-records.json.dpapi"`. Verify decryption, record counts and search handling without opening a window with `pwsh -NoProfile -File private-records.ps1 -VerifyOnly`.

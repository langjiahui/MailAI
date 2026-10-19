package com.mailai.mobile.data

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import com.mailai.mobile.mail.MailAddresses
import com.mailai.mobile.mail.MailContact
import com.mailai.mobile.mail.MimeCodec
import java.util.Locale
import org.json.JSONObject

/**
 * Account-local learning from cached headers only; never fetches bodies or guesses a person's name.
 */
internal object ContactLearning {
    fun create(db: SQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE contacts (email TEXT PRIMARY KEY COLLATE NOCASE, name TEXT NOT NULL, updated INTEGER NOT NULL, manual INTEGER NOT NULL DEFAULT 0, name_date INTEGER NOT NULL DEFAULT 0)"
        )
        createState(db)
    }

    private fun createState(db: SQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE contact_learning (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)"
        )
    }

    fun migrateV3(db: SQLiteDatabase) {
        db.execSQL("ALTER TABLE contacts ADD COLUMN manual INTEGER NOT NULL DEFAULT 0")
        db.execSQL("ALTER TABLE contacts ADD COLUMN name_date INTEGER NOT NULL DEFAULT 0")
        createState(db)
        // v3 never recorded provenance. Protect meaningful existing names conservatively;
        // aliases that only repeat an address/local part can safely be enriched.
        db.rawQuery("SELECT email,name FROM contacts", null).use { rows ->
            while (rows.moveToNext()) {
                val email = rows.getString(0)
                val name = automaticName(MailContact(email, rows.getString(1)))
                db.update(
                    "contacts",
                    ContentValues().apply {
                        put("name", name)
                        put("manual", if (name.isBlank()) 0 else 1)
                    },
                    "email=? COLLATE NOCASE",
                    arrayOf(email),
                )
            }
        }
    }

    fun initialize(db: SQLiteDatabase) =
        transaction(db) {
            val done =
                db.rawQuery("SELECT version FROM contact_learning WHERE id=1", null).use {
                    it.moveToFirst() && it.getInt(0) >= 1
                }
            if (!done) {
                // All cached folders, including sent mail, even when the address book is nonempty.
                // Stream one payload at a time; no arbitrary 500-mail cutoff or UI-time rescan.
                db.rawQuery("SELECT payload,date FROM messages ORDER BY date,key", null).use { rows
                    ->
                    while (rows.moveToNext()) {
                        val mail = JSONObject(rows.getString(0))
                        remember(
                            db,
                            listOf(
                                mail.optString("sender"),
                                mail.optString("recipients"),
                                mail.optString("cc"),
                            ),
                            rows.getLong(1),
                        )
                    }
                }
                db.rawQuery("SELECT payload,updated FROM drafts ORDER BY updated,id", null).use {
                    rows ->
                    while (rows.moveToNext()) {
                        val draft = JSONObject(rows.getString(0))
                        remember(
                            db,
                            listOf(
                                draft.optString("to"),
                                draft.optString("cc"),
                                draft.optString("bcc"),
                            ),
                            rows.getLong(1),
                        )
                    }
                }
                db.execSQL("INSERT OR REPLACE INTO contact_learning(id,version) VALUES(1,1)")
            }
        }

    fun remember(db: SQLiteDatabase, headers: List<String>, observedAt: Long) =
        transaction(db) {
            val date = observedAt.coerceIn(0, System.currentTimeMillis())
            // Parse fields separately: a malformed header must not hide contacts in another field.
            for (raw in headers) for (contact in MailAddresses.parse(raw)) {
                val email = contact.email.lowercase(Locale.ROOT)
                val incoming = automaticName(contact)
                val values =
                    ContentValues().apply {
                        put("email", email)
                        put("name", incoming)
                        put("updated", date)
                        put("name_date", if (incoming.isBlank()) 0 else date)
                    }
                if (
                    db.insertWithOnConflict(
                        "contacts",
                        null,
                        values,
                        SQLiteDatabase.CONFLICT_IGNORE,
                    ) != -1L
                )
                    continue
                db.rawQuery(
                        "SELECT name,manual,name_date,updated FROM contacts WHERE email=? COLLATE NOCASE",
                        arrayOf(email),
                    )
                    .use { row ->
                        check(row.moveToFirst())
                        if (row.getInt(1) != 0) return@use
                        val old = row.getString(0)
                        val oldDate = row.getLong(2)
                        val replace =
                            incoming.isNotBlank() &&
                                (old.isBlank() ||
                                    (chinese(incoming) && !chinese(old)) ||
                                    (chinese(incoming) == chinese(old) && date >= oldDate))
                        val name = if (replace) incoming else old
                        val nameDate = if (replace) date else oldDate
                        val updated = maxOf(row.getLong(3), date)
                        if (name != old || nameDate != oldDate || updated != row.getLong(3)) {
                            db.update(
                                "contacts",
                                ContentValues().apply {
                                    put("name", name)
                                    put("name_date", nameDate)
                                    put("updated", updated)
                                },
                                "email=? COLLATE NOCASE",
                                arrayOf(email),
                            )
                        }
                    }
            }
        }

    fun saveManual(db: SQLiteDatabase, contact: MailContact) {
        val address = MimeCodec.addresses(contact.email.trim()).single()
        check(
            db.insertWithOnConflict(
                "contacts",
                null,
                ContentValues().apply {
                    put("email", address.address.lowercase(Locale.ROOT))
                    put("name", contact.name.trim().take(160))
                    put("updated", System.currentTimeMillis())
                    put("manual", 1)
                    put("name_date", 0)
                },
                SQLiteDatabase.CONFLICT_REPLACE,
            ) != -1L
        )
    }

    private fun automaticName(contact: MailContact): String {
        val name = MailAddresses.decode(contact.name).take(160)
        return name
            .takeUnless {
                it.isBlank() ||
                    '@' in it ||
                    it.equals(contact.email.substringBefore('@'), true) ||
                    it.contains("=?") ||
                    it.any { c -> c.isISOControl() }
            }
            .orEmpty()
    }

    private fun chinese(name: String) =
        name.codePoints().anyMatch { Character.UnicodeScript.of(it) == Character.UnicodeScript.HAN }

    private inline fun transaction(db: SQLiteDatabase, block: () -> Unit) {
        val owns = !db.inTransaction()
        if (owns) db.beginTransaction()
        try {
            block()
            if (owns) db.setTransactionSuccessful()
        } finally {
            if (owns) db.endTransaction()
        }
    }
}

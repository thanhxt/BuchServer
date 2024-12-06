// Copyright (C) 2016 - present Juergen Zimmermann, Hochschule Karlsruhe
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

/**
 * Das Modul besteht aus der Klasse {@linkcode BuchWriteService} für die
 * Schreiboperationen im Anwendungskern.
 * @packageDocumentation
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { type DeleteResult, Repository } from 'typeorm';
import { getLogger } from '../../logger/logger.js';
import { MailService } from '../../mail/mail.service.js';
import { Abbildung } from '../entity/abbildung.entity.js';
import { Buch } from '../entity/buch.entity.js';
import { BuchFile } from '../entity/buchFile.entity.js';
import { Titel } from '../entity/titel.entity.js';
import { BuchReadService } from './buch-read.service.js';
import {
    IsbnExistsException,
    VersionInvalidException,
    VersionOutdatedException,
} from './exceptions.js';

/** Typdefinitionen zum Aktualisieren eines Buches mit `update`. */
export type UpdateParams = {
    /** ID des zu aktualisierenden Buches. */
    readonly id: number | undefined;
    /** Buch-Objekt mit den aktualisierten Werten. */
    readonly buch: Buch;
    /** Versionsnummer für die aktualisierenden Werte. */
    readonly version: string;
};

export type UpdateFileParams = {
    readonly id: number | undefined;
    readonly buchFile: BuchFile;
    readonly version: string;
};

// TODO Transaktionen, wenn mehr als 1 TypeORM-Schreibmethode involviert ist
// https://docs.nestjs.com/techniques/database#typeorm-transactions
// https://papooch.github.io/nestjs-cls/plugins/available-plugins/transactional
// https://betterprogramming.pub/handling-transactions-in-typeorm-and-nest-js-with-ease-3a417e6ab5
// https://bytesmith.dev/blog/20240320-nestjs-transactions

/**
 * Die Klasse `BuchWriteService` implementiert den Anwendungskern für das
 * Schreiben von Bücher und greift mit _TypeORM_ auf die DB zu.
 */
@Injectable()
export class BuchWriteService {
    private static readonly VERSION_PATTERN = /^"\d{1,3}"/u;

    readonly #repo: Repository<Buch>;

    readonly #readService: BuchReadService;

    readonly #mailService: MailService;

    readonly #logger = getLogger(BuchWriteService.name);

    constructor(
        @InjectRepository(Buch) repo: Repository<Buch>,
        readService: BuchReadService,
        mailService: MailService,
    ) {
        this.#repo = repo;
        this.#readService = readService;
        this.#mailService = mailService;
    }

    /**
     * Ein neues Buch soll angelegt werden.
     * @param buch Das neu abzulegende Buch
     * @returns Die ID des neu angelegten Buches
     * @throws IsbnExists falls die ISBN-Nummer bereits existiert
     */
    async create(buch: Buch): Promise<number> {
        this.#logger.debug('create: buch=%o', buch);
        await this.#validateCreate(buch);

        const buchDb = await this.#repo.save(buch); // implizite Transaktion
        this.#logger.debug('create: buchDb=%o', buchDb);

        await this.#sendmail(buchDb);

        return buchDb.id!;
    }

    /**
     * Ein vorhandenes Buch soll aktualisiert werden. "Destructured" Argument
     * mit id (ID des zu aktualisierenden Buchs), buch (zu aktualisierendes Buch)
     * und version (Versionsnummer für optimistische Synchronisation).
     * @returns Die neue Versionsnummer gemäß optimistischer Synchronisation
     * @throws NotFoundException falls kein Buch zur ID vorhanden ist
     * @throws VersionInvalidException falls die Versionsnummer ungültig ist
     * @throws VersionOutdatedException falls die Versionsnummer veraltet ist
     */
    // https://2ality.com/2015/01/es6-destructuring.html#simulating-named-parameters-in-javascript
    async update({ id, buch, version }: UpdateParams): Promise<number> {
        this.#logger.debug(
            'update: id=%d, buch=%o, version=%s',
            id,
            buch,
            version,
        );
        if (id === undefined) {
            this.#logger.debug('update: Keine gueltige ID');
            throw new NotFoundException(`Es gibt kein Buch mit der ID ${id}.`);
        }

        const validateResult = await this.#validateUpdate(buch, id, version);
        this.#logger.debug('update: validateResult=%o', validateResult);
        if (!(validateResult instanceof Buch)) {
            return validateResult;
        }

        const buchNeu = validateResult;
        const merged = this.#repo.merge(buchNeu, buch);
        this.#logger.debug('update: merged=%o', merged);
        const updated = await this.#repo.save(merged); // implizite Transaktion
        this.#logger.debug('update: updated=%o', updated);

        return updated.version!;
    }

    async updateFile({ id, buchFile, version }: UpdateFileParams): Promise<number> {
        this.#logger.debug('updateFile: id=%d, buchFile=%o, version=%s', id, buchFile.filename, version);
        if (id === undefined) {
            this.#logger.debug('updateFile: Keine gueltige ID');
            throw new NotFoundException(`Es gibt kein Buch mit der ID ${id}.`);
        }


        // TODO Buch-File bereits vorhanden Exception werfen
        // TODO in validateFileUpdate implementieren
        const validateResult = await this.#validateFileUpdate(buchFile, id, version);
        // TODO bekommte ein Promise<Buch> zurück, wird aber als Object erkannt
        // if (!(validateResult instanceof Buch)) {
        //     return validateResult;
        // }

        const buch = {
            ...validateResult,
            file:buchFile,
        } as Buch;

        if (buch.file === undefined) {
            throw new NotFoundException(`Es gibt kein Buch-File mit der ID ${id}.`);
        }

        const merged = this.#repo.merge(buch, buchFile);
        this.#logger.debug('updateFile: merged=%o', merged.file?.filename);
        const updated = await this.#repo.save(merged);
        this.#logger.debug('updateFile: updated=%o', updated.file?.filename);
        return updated.version!;
    }

    /**
     * Ein Buch wird asynchron anhand seiner ID gelöscht.
     *
     * @param id ID des zu löschenden Buches
     * @returns true, falls das Buch vorhanden war und gelöscht wurde. Sonst false.
     */
    async delete(id: number) {
        this.#logger.debug('delete: id=%d', id);
        const buch = await this.#readService.findById({
            id,
            mitAbbildungen: true,
        });

        let deleteResult: DeleteResult | undefined;
        await this.#repo.manager.transaction(async (transactionalMgr) => {
            // Das Buch zur gegebenen ID mit Titel und Abb. asynchron loeschen

            // TODO "cascade" funktioniert nicht beim Loeschen
            const titelId = buch.titel?.id;
            if (titelId !== undefined) {
                await transactionalMgr.delete(Titel, titelId);
            }
            // "Nullish Coalescing" ab ES2020
            const abbildungen = buch.abbildungen ?? [];
            for (const abbildung of abbildungen) {
                await transactionalMgr.delete(Abbildung, abbildung.id);
            }

            deleteResult = await transactionalMgr.delete(Buch, id);
            this.#logger.debug('delete: deleteResult=%o', deleteResult);
        });

        return (
            deleteResult?.affected !== undefined &&
            deleteResult.affected !== null &&
            deleteResult.affected > 0
        );
    }

    /**
     * Ein Buch-File wird asynchron anhand seiner ID gelöscht.
     * @param id ID des zu löschenden Buch-Files
     * @returns true, falls das Buch-File vorhanden war und gelöscht wurde. Sonst false.
     */
    async deleteFile(id: number) {
        this.#logger.debug('deleteFile: id=%d', id);
        const buch = await this.#readService.findFile(id);
        let deleteResult: DeleteResult | undefined;
        await this.#repo.manager.transaction(async (transactionalMgr) =>{
            const fileid = buch?.id;
            if (fileid !== undefined) {
                await transactionalMgr.delete(BuchFile, fileid);
            }
            deleteResult = await transactionalMgr.delete(BuchFile, fileid);
            this.#logger.debug('deleteFile: deleteResult=%o', deleteResult);
        })
        return (
            deleteResult?.affected !== undefined &&
            deleteResult.affected !== null &&
            deleteResult.affected > 0
        );
    }

    async #validateCreate({ isbn }: Buch): Promise<undefined> {
        this.#logger.debug('#validateCreate: isbn=%s', isbn);
        if (await this.#repo.existsBy({ isbn })) {
            throw new IsbnExistsException(isbn);
        }
    }

    async #sendmail(buch: Buch) {
        const subject = `Neues Buch ${buch.id}`;
        const titel = buch.titel?.titel ?? 'N/A';
        const body = `Das Buch mit dem Titel <strong>${titel}</strong> ist angelegt`;
        await this.#mailService.sendmail({ subject, body });
    }

    async #validateUpdate(
        buch: Buch,
        id: number,
        versionStr: string,
    ): Promise<Buch> {
        this.#logger.debug(
            '#validateUpdate: buch=%o, id=%s, versionStr=%s',
            buch,
            id,
            versionStr,
        );
        if (!BuchWriteService.VERSION_PATTERN.test(versionStr)) {
            throw new VersionInvalidException(versionStr);
        }

        const version = Number.parseInt(versionStr.slice(1, -1), 10);
        this.#logger.debug(
            '#validateUpdate: buch=%o, version=%d',
            buch,
            version,
        );

        const buchDb = await this.#readService.findById({ id });

        // nullish coalescing
        const versionDb = buchDb.version!;
        if (version < versionDb) {
            this.#logger.debug('#validateUpdate: versionDb=%d', version);
            throw new VersionOutdatedException(version);
        }
        this.#logger.debug('#validateUpdate: buchDb=%o', buchDb);
        return buchDb;
    }

    async #validateFileUpdate(
        file: BuchFile,
        id: number,
        versionStr: string,
    ): Promise<Buch> {
        this.#logger.debug('validateFileUpdate: file=%o, id=%s, versionStr=%s', file.filename, id, versionStr);
        if (!BuchWriteService.VERSION_PATTERN.test(versionStr)) {
            throw new VersionInvalidException(versionStr);
        }

        const buchOhneFile = await this.#readService.findById({ id });
        
        if (buchOhneFile.file !== undefined) {
            throw new NotFoundException(`Es gibt bereits ein Buch-File mit der IDs ${id}.`);
        }

        const buch = {
            ...buchOhneFile,
            file: file,
        }

        // Extract version number from string like '"1"' by removing quotes and parsing as integer
        const version = Number.parseInt(versionStr.slice(1, -1), 10);
        this.#logger.debug(
            '#validateUpdate: buch=%o, version=%d',
            buch.file?.filename,
            version,
        );

        const versionDb = buch.version!;
        this.#logger.debug('version=%d, versionDb=%d', version, versionDb);
        if (version < versionDb) {
            throw new VersionOutdatedException(version);
        }
        this.#logger.debug('#validateUpdate: buch=%o', buch.file?.filename);
        return buch;
    }
}

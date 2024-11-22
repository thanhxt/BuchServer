// eslint-disable-next-line @eslint-community/eslint-comments/disable-enable-pair
/* eslint-disable @typescript-eslint/no-magic-numbers */
/**
 * Das Modul besteht aus der Entity-Klasse.
 * @packageDocumentation
 */
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Entity-Klasse für BuchFile ohne TypeORM
 */
export class BuchFileDTO {
    @IsString()
    @MaxLength(40)
    @IsNotEmpty()
    readonly filename!: string;

    @IsNotEmpty()
    readonly data!: Buffer;
}

import {
    Column,
    Entity,
    JoinColumn,
    OneToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { Buch } from './buch.entity.js';

@Entity()
export class BuchFile {
    @PrimaryGeneratedColumn()
    id: number | undefined;

    @Column('varchar')
    filename: string | undefined;

    @Column({
        type: 'blob',
    })
    data: Buffer | undefined;

    @OneToOne(() => Buch, (buch) => buch.file)
    @JoinColumn({ name: 'buch_id' })
    buch: Buch | undefined;

    public toString = (): string =>
        JSON.stringify({
            id: this.id,
            filename: this.filename,
        });
}

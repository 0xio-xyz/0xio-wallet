import { isOctAddress } from 'src/utils/octra/address';
import { isEvmAddress } from '../evm/tx';
interface Contact {
  id: string;
  name: string;
  address: string;
  memo: string;
  category: string;
  isFavorite: boolean;
  createdAt: number;
  updatedAt: number;
}

interface AddressBookData {
  version: string;
  contacts: Contact[];
  settings: {
    sortBy: string;
    showCategories: boolean;
  };
}

interface AddContactInput {
  name: string;
  address: string;
  memo?: string;
  category?: string;
  isFavorite?: boolean;
}

export class AddressBookService {
  private STORAGE_KEY = 'addressBook';

  async initialize(): Promise<void> {
    const storage = await chrome.storage.local.get([this.STORAGE_KEY]);
    if (!storage[this.STORAGE_KEY]) {
      await chrome.storage.local.set({
        [this.STORAGE_KEY]: {
          version: '1.0',
          contacts: [],
          settings: {
            sortBy: 'name',
            showCategories: true,
          },
        },
      });
    }
  }

  async getAllContacts(): Promise<Contact[]> {
    const storage = await chrome.storage.local.get([this.STORAGE_KEY]);
    const addressBook: AddressBookData = storage[this.STORAGE_KEY] || { contacts: [] };
    return addressBook.contacts || [];
  }

  async addContact({
    name,
    address,
    memo = '',
    category = 'other',
    isFavorite = false,
  }: AddContactInput): Promise<Contact> {
    if (!name || name.trim().length === 0) {
      throw new Error('Contact name is required');
    }
    if (!address || !this.isValidAddress(address)) {
      throw new Error('Invalid address');
    }

    const contacts = await this.getAllContacts();
    const duplicate = contacts.find((c) => c.address.toLowerCase() === address.toLowerCase());
    if (duplicate) {
      throw new Error(`Address already exists as "${duplicate.name}"`);
    }

    const contact: Contact = {
      id: this.generateId(),
      name: name.trim().substring(0, 50),
      address: address.trim(),
      memo: memo.trim().substring(0, 200),
      category,
      isFavorite,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    contacts.push(contact);
    await this.saveContacts(contacts);
    return contact;
  }

  async updateContact(id: string, updates: Partial<Contact>): Promise<Contact> {
    const contacts = await this.getAllContacts();
    const index = contacts.findIndex((c) => c.id === id);

    if (index === -1) {
      throw new Error('Contact not found');
    }

    if (updates.address && !this.isValidAddress(updates.address)) {
      throw new Error('Invalid address');
    }

    if (updates.address && updates.address !== contacts[index].address) {
      const duplicate = contacts.find(
        (c) => c.id !== id && c.address.toLowerCase() === updates.address!.toLowerCase()
      );
      if (duplicate) {
        throw new Error(`Address already exists as "${duplicate.name}"`);
      }
    }

    const clean: Partial<Contact> = { ...updates };
    if (typeof clean.name === 'string') {
      if (!clean.name.trim()) throw new Error('Contact name is required');
      clean.name = clean.name.trim().substring(0, 50);
    }
    if (typeof clean.memo === 'string') clean.memo = clean.memo.trim().substring(0, 200);
    if (typeof clean.address === 'string') clean.address = clean.address.trim();

    contacts[index] = {
      ...contacts[index],
      ...clean,
      id: contacts[index].id,
      createdAt: contacts[index].createdAt,
      updatedAt: Date.now(),
    };

    await this.saveContacts(contacts);
    return contacts[index];
  }

  async deleteContact(id: string): Promise<boolean> {
    const contacts = await this.getAllContacts();
    const filtered = contacts.filter((c) => c.id !== id);

    if (filtered.length === contacts.length) {
      throw new Error('Contact not found');
    }

    await this.saveContacts(filtered);
    return true;
  }

  async getContactByAddress(address: string): Promise<Contact | null> {
    const contacts = await this.getAllContacts();
    return contacts.find((c) => c.address.toLowerCase() === address.toLowerCase()) || null;
  }

  async toggleFavorite(id: string): Promise<Contact> {
    const contacts = await this.getAllContacts();
    const contact = contacts.find((c) => c.id === id);

    if (!contact) {
      throw new Error('Contact not found');
    }

    return await this.updateContact(id, { isFavorite: !contact.isFavorite });
  }

  async exportContacts(): Promise<string> {
    const contacts = await this.getAllContacts();
    return JSON.stringify(
      {
        version: '1.0',
        exportedAt: Date.now(),
        contacts,
      },
      null,
      2
    );
  }

  async importContacts(jsonData: string, merge = true): Promise<number> {
    try {
      const data = JSON.parse(jsonData);
      if (!data.contacts || !Array.isArray(data.contacts)) {
        throw new Error('Invalid import format');
      }

      const existingContacts = merge ? await this.getAllContacts() : [];
      let imported = 0;

      for (const contact of data.contacts) {
        if (!contact || typeof contact !== 'object') continue;
        const address = typeof contact.address === 'string' ? contact.address.trim() : '';
        const name = typeof contact.name === 'string' ? contact.name.trim().substring(0, 50) : '';
        if (!name || !this.isValidAddress(address)) continue;
        if (existingContacts.some((c) => c.address.toLowerCase() === address.toLowerCase())) {
          continue;
        }
        existingContacts.push({
          id: this.generateId(),
          name,
          address,
          memo: typeof contact.memo === 'string' ? contact.memo.trim().substring(0, 200) : '',
          category: typeof contact.category === 'string' ? contact.category : 'other',
          isFavorite: contact.isFavorite === true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        imported++;
      }

      await this.saveContacts(existingContacts);
      return imported;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Import failed: ${msg}`);
    }
  }

  async saveContacts(contacts: Contact[]): Promise<void> {
    const storage = await chrome.storage.local.get([this.STORAGE_KEY]);
    const addressBook = storage[this.STORAGE_KEY] || { version: '1.0', settings: {} };

    await chrome.storage.local.set({
      [this.STORAGE_KEY]: {
        ...addressBook,
        contacts,
      },
    });
  }

  isValidAddress(address: string): boolean {
    return isOctAddress(address) || isEvmAddress(address);
  }

  generateId(): string {
    return crypto.randomUUID();
  }
}

export const addressBookService = new AddressBookService();
